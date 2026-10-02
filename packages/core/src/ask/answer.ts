/**
 * "Ask": answers a question from the company's stored emails with cited sources.
 *
 * `runAskLoop` is the model loop (no DB: it gets a tool executor), with hard
 * limits on tool calls and input tokens. `validateAnswer` checks every citation
 * against the emails the tools actually returned for THIS question.
 * `answerQuestion` is the DB-backed entry point: limits, session, usage, audit.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, supportsEffort } from "../ai/client.js";
import { estimateTokens, type TokenUsage } from "../ai/pricing.js";
import { formatLocalDate } from "../ai/prompts.js";
import { countCallsToday, recordUsage, startOfLocalDay, usageFromMessage, type SummaryClient } from "../ai/summarize-thread.js";
import { logAudit } from "../auth/audit.js";
import type { SessionContext } from "../auth/permissions.js";
import type { Prisma, PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { createLogger } from "../log.js";
import { askSystemPrompt, FINAL_ANSWER_TOOL, FINAL_ANSWER_TOOL_NAME, FinalAnswerSchema, historyMessages, questionMessage, type FinalAnswer, type PriorTurn } from "./prompt.js";
import { createToolExecutor, dayBound, RETRIEVAL_TOOLS, type AskScope, type ToolExecutor } from "./tools.js";

const log = createLogger("ask");

// ---------------------------------------------------------------------------
// Model loop

export interface AskLimits {
  /** retrieval tool calls per question */
  maxToolCalls: number;
  /** size of the conversation sent to the model, in input tokens */
  maxInputTokens: number;
  /** stop searching once this time passes (serverless time limit), so the answer is still returned and stored */
  deadlineAt?: Date;
}
export const DEFAULT_ASK_LIMITS: AskLimits = { maxToolCalls: 6, maxInputTokens: 40_000 };
export const MAX_TURNS_PER_SESSION = 10;

export interface CallUsage extends TokenUsage {
  model: string;
  error: string | null;
}

export interface LoopRequest {
  model: string;
  system: string;
  /** earlier turns + the new question */
  messages: Anthropic.MessageParam[];
  effort: "low" | "medium" | "high";
}

export interface LoopResult {
  answer: FinalAnswer | null;
  error: string | null;
  calls: CallUsage[];
  toolCalls: number;
  /** ids of every email a tool returned for this question */
  returnedIds: Set<string>;
  limitHit: "tool_calls" | "token_budget" | "time" | null;
}

export type AskEvent = { type: "status"; text: string };

const STATUS: Record<string, (input: unknown) => string> = {
  search_emails: () => "Searching emails…",
  search_threads: () => "Searching threads…",
  get_thread: () => "Reading the thread…",
  get_messages: (input) => {
    const n = Array.isArray((input as { messageIds?: unknown })?.messageIds) ? (input as { messageIds: unknown[] }).messageIds.length : 0;
    return `Reading ${n} email${n === 1 ? "" : "s"}…`;
  },
};

const LIMIT_TEXT = {
  tool_calls: "Tool call limit reached for this question. Do not search any more: call final_answer now with what you already found, and say that the search was cut short.",
  token_budget: "Reading budget reached for this question. Do not search any more: call final_answer now with what you already found, and say that the search was cut short.",
  time: "Time limit reached for this question. Do not search any more: call final_answer now with what you already found, and say that the search was cut short.",
};

/** The system prompt and tools are one cached prefix; top-level cache_control caches the growing conversation between rounds. */
export function buildAskParams(req: LoopRequest, messages: Anthropic.MessageParam[]): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: 8000,
    cache_control: { type: "ephemeral" },
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages,
    tools: [...RETRIEVAL_TOOLS, FINAL_ANSWER_TOOL],
    tool_choice: { type: "auto" },
    ...(supportsEffort(req.model) ? { output_config: { effort: req.effort } } : {}),
  };
}

const toolResult = (id: string, content: string, isError = false): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) });

/**
 * Runs the tool-use loop for one question. Never throws for model problems.
 * Once a limit is hit no further tool runs; the model is told to answer with
 * what it has. Malformed or missing final answers get one corrective round.
 */
export async function runAskLoop(client: SummaryClient, req: LoopRequest, execute: ToolExecutor, limits: AskLimits = DEFAULT_ASK_LIMITS, onEvent?: (e: AskEvent) => void): Promise<LoopResult> {
  const out: LoopResult = { answer: null, error: null, calls: [], toolCalls: 0, returnedIds: new Set(), limitHit: null };
  const messages = [...req.messages];
  let corrections = 0;
  // Every round either runs a tool, hits a limit or is a correction, so this bound is never the binding one.
  for (let round = 0; round < limits.maxToolCalls + 4; round++) {
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(buildAskParams(req, messages));
    } catch (err) {
      const status = (err as { status?: number }).status;
      out.error = `api_error${status ? ` ${status}` : ""}: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
      out.calls.push({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: req.model, error: out.error });
      return out;
    }
    const usage = usageFromMessage(message.usage);
    const terminal = message.stop_reason === "refusal" || message.stop_reason === "max_tokens" ? message.stop_reason : null;
    out.calls.push({ ...usage, model: message.model || req.model, error: terminal });
    if (terminal) {
      out.error = terminal;
      return out;
    }

    const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const final = uses.find((u) => u.name === FINAL_ANSWER_TOOL_NAME);
    if (final) {
      const parsed = FinalAnswerSchema.safeParse(final.input);
      if (parsed.success) {
        out.answer = parsed.data;
        out.error = null;
        return out;
      }
      out.error = `invalid_output: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      if (corrections++ >= 1) return out;
      messages.push({ role: "assistant", content: message.content }, { role: "user", content: uses.map((u) => toolResult(u.id, u === final ? `Invalid final_answer (${out.error}). Call final_answer again with valid fields.` : "Not run.", true)) });
      continue;
    }
    if (!uses.length) {
      out.error = "no_final_answer";
      if (corrections++ >= 1) return out;
      messages.push({ role: "assistant", content: message.content }, { role: "user", content: `Give your answer by calling the ${FINAL_ANSWER_TOOL_NAME} tool.` });
      continue;
    }
    out.error = null;

    // What this request weighed is known exactly; tool results added in this round are estimated on top of it.
    let context = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of uses) {
      if (!out.limitHit && out.toolCalls >= limits.maxToolCalls) out.limitHit = "tool_calls";
      if (!out.limitHit && context >= limits.maxInputTokens) out.limitHit = "token_budget";
      if (!out.limitHit && limits.deadlineAt && Date.now() >= limits.deadlineAt.getTime()) out.limitHit = "time";
      if (out.limitHit) {
        results.push(toolResult(use.id, LIMIT_TEXT[out.limitHit], true));
        continue;
      }
      out.toolCalls += 1;
      onEvent?.({ type: "status", text: (STATUS[use.name] ?? (() => "Working…"))(use.input) });
      const result = await execute(use.name, use.input, Math.max(2000, Math.floor((limits.maxInputTokens - context) * 3.5)));
      for (const id of result.messageIds) out.returnedIds.add(id);
      context += estimateTokens(result.content);
      results.push(toolResult(use.id, result.content, result.isError));
    }
    messages.push({ role: "assistant", content: message.content }, { role: "user", content: results });
  }
  out.error ??= "no_final_answer";
  return out;
}

// ---------------------------------------------------------------------------
// Citation validation

export interface ValidatedAnswer {
  answerMarkdown: string;
  citations: { marker: string; messageId: string }[];
  found: boolean;
  /** the model claimed an answer but none of its citations point at an email it was actually shown */
  unverified: boolean;
}

/**
 * Keeps only citations whose email was returned by a tool for this question and
 * strips the markers of the others from the text. An answer that claims facts
 * with no valid citation left is flagged "unverified" rather than re-asked: a
 * retry costs another full-context call and can fail the same way, while the
 * flag is free and tells the reader exactly how far to trust the text.
 */
export function validateAnswer(answer: FinalAnswer, returnedIds: ReadonlySet<string>): ValidatedAnswer {
  const byMarker = new Map<string, string>();
  for (const c of answer.citations) if (returnedIds.has(c.messageId) && !byMarker.has(c.marker)) byMarker.set(c.marker, c.messageId);
  const used = new Set<string>();
  const answerMarkdown = answer.answer_markdown
    .replace(/[ \t]*\[(\d{1,2})\]/g, (whole, marker: string) => {
      if (!byMarker.has(marker)) return "";
      used.add(marker);
      return whole;
    })
    .trim();
  const citations = [...byMarker].filter(([marker]) => used.has(marker)).map(([marker, messageId]) => ({ marker, messageId }));
  return { answerMarkdown, citations, found: answer.found, unverified: answer.found && citations.length === 0 };
}

// ---------------------------------------------------------------------------
// DB-backed entry point

export interface AskFilters {
  mailboxId?: string | null;
  /** YYYY-MM-DD, company timezone */
  after?: string | null;
  before?: string | null;
  threadId?: string | null;
}

export interface AskInput {
  /** from the signed-in session: who is asking, in which company */
  ctx: SessionContext;
  sessionId?: string | null;
  question: string;
  deep?: boolean;
  filters?: AskFilters;
}

export interface AskDeps {
  client?: SummaryClient;
  now?: Date;
  limits?: AskLimits;
  onEvent?: (e: AskEvent) => void;
}

/** A citation with a snapshot of its email, as stored on the turn and shown under the answer. */
export interface SourceCitation {
  marker: string;
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  mailbox: string;
  webLink: string | null;
}

export type AskFailure = "cap_reached" | "user_limit" | "session_full" | "session_not_found" | "empty_question";

export type AskOutcome =
  | { ok: false; code: AskFailure; message: string }
  | {
      ok: true;
      sessionId: string;
      turnId: string;
      answerMarkdown: string;
      citations: SourceCitation[];
      found: boolean;
      unverified: boolean;
      limitHit: LoopResult["limitHit"];
      error: string | null;
      model: string;
      deep: boolean;
      costUsd: number;
      toolCalls: number;
      emailsRead: number;
    };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What one user may search: the company's mailboxes (the caller has already
 * checked the membership that `ctx` carries), narrowed by the filters chosen in
 * the UI. A filter naming a mailbox or thread outside the company is dropped.
 */
export async function resolveAskScope(db: PrismaClient, ctx: Pick<SessionContext, "orgId">, timezone: string, filters: AskFilters = {}): Promise<{ scope: AskScope; labels: string[] }> {
  const mailboxes = await db.mailbox.findMany({ where: { orgId: ctx.orgId }, select: { id: true, emailAddress: true }, orderBy: { emailAddress: "asc" } });
  const mailbox = filters.mailboxId ? mailboxes.find((m) => m.id === filters.mailboxId) : undefined;
  const thread = filters.threadId ? await db.thread.findFirst({ where: { id: filters.threadId, mailboxId: { in: mailboxes.map((m) => m.id) } }, select: { id: true, subject: true } }) : null;
  const after = filters.after && DAY_RE.test(filters.after) ? filters.after : null;
  const before = filters.before && DAY_RE.test(filters.before) ? filters.before : null;
  const labels = [mailbox && `mailbox ${mailbox.emailAddress}`, after && `from ${after}`, before && `until ${before}`, thread && `the thread "${thread.subject}" (threadId ${thread.id})`].filter((l): l is string => !!l);
  return {
    scope: { orgId: ctx.orgId, timezone, mailboxes, mailboxId: mailbox?.id ?? null, after: after ? dayBound(after, timezone, false) : null, before: before ? dayBound(before, timezone, true) : null, threadId: thread?.id ?? null },
    labels,
  };
}

async function sourceCitations(db: PrismaClient, scope: AskScope, citations: { marker: string; messageId: string }[]): Promise<SourceCitation[]> {
  if (!citations.length) return [];
  const rows = await db.message.findMany({
    where: { id: { in: citations.map((c) => c.messageId) }, mailboxId: { in: scope.mailboxes.map((m) => m.id) } },
    select: { id: true, threadId: true, subject: true, fromAddress: true, fromName: true, toAddresses: true, receivedAt: true, webLink: true, mailbox: { select: { emailAddress: true } } },
  });
  const byId = new Map(rows.map((m) => [m.id, m]));
  return citations.flatMap((c) => {
    const m = byId.get(c.messageId);
    if (!m) return [];
    return [{
      marker: c.marker, messageId: m.id, threadId: m.threadId, subject: m.subject, from: m.fromName?.trim() || m.fromAddress,
      to: (m.toAddresses as unknown as { address: string }[]).map((r) => r.address).join(", "), date: formatLocalDate(m.receivedAt, scope.timezone), mailbox: m.mailbox.emailAddress, webLink: m.webLink || null,
    }];
  });
}

const NOT_ANSWERED = "The answer could not be generated. Please try again.";

/**
 * Answers one question for one user. Checks the company's daily AI cap and the
 * user's daily question limit, runs the loop, validates citations, stores the
 * turn, logs every API call in AiUsage (purpose "chat") and audits the question.
 */
export async function answerQuestion(db: PrismaClient, input: AskInput, deps: AskDeps = {}): Promise<AskOutcome> {
  const env = getEnv();
  const now = deps.now ?? new Date();
  const { ctx } = input;
  const question = input.question.trim().slice(0, 2000);
  if (!question) return { ok: false, code: "empty_question", message: "Type a question first." };
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { id: true, name: true, timezone: true, aiContext: true, domain: true } });

  if ((await countCallsToday(db, org.id, org.timezone, now)) >= env.AI_MAX_CALLS_PER_DAY) return { ok: false, code: "cap_reached", message: "The company's daily AI limit is reached. Try again tomorrow." };
  const askedToday = await db.chatTurn.count({ where: { session: { orgId: org.id, userId: ctx.userId }, createdAt: { gte: startOfLocalDay(now, org.timezone) } } });
  if (askedToday >= env.AI_CHAT_MAX_QUESTIONS_PER_USER_PER_DAY) return { ok: false, code: "user_limit", message: `You reached today's limit of ${env.AI_CHAT_MAX_QUESTIONS_PER_USER_PER_DAY} questions. Try again tomorrow.` };

  // A session is private to its user: another user's id is simply "not found".
  const session = input.sessionId ? await db.chatSession.findFirst({ where: { id: input.sessionId, orgId: org.id, userId: ctx.userId }, include: { turns: { orderBy: { createdAt: "asc" } } } }) : null;
  if (input.sessionId && !session) return { ok: false, code: "session_not_found", message: "This chat no longer exists. Start a new one." };
  if (session && session.turns.length >= MAX_TURNS_PER_SESSION) return { ok: false, code: "session_full", message: `This chat reached ${MAX_TURNS_PER_SESSION} questions. Start a new chat to continue.` };

  const { scope, labels } = await resolveAskScope(db, ctx, org.timezone, input.filters);
  const model = input.deep ? env.ANTHROPIC_CHAT_DEEP_MODEL : env.ANTHROPIC_CHAT_MODEL;
  const prior: PriorTurn[] = (session?.turns ?? []).filter((t) => !t.error).map((t) => ({ question: t.question, answerMarkdown: t.answerMarkdown, citations: t.citations as unknown as PriorTurn["citations"] }));
  const loop = await runAskLoop(
    deps.client ?? getAnthropic(),
    { model, system: askSystemPrompt(org), effort: env.AI_EFFORT, messages: [...historyMessages(prior), { role: "user", content: questionMessage(question, { now, timezone: org.timezone, filters: labels }) }] },
    createToolExecutor(db, scope),
    deps.limits,
    deps.onEvent,
  );

  const costUsd = await recordUsage(db, org.id, null, loop.calls.map((c) => ({ ...c, batch: false })), { purpose: "chat", userId: ctx.userId });
  const validated = loop.answer ? validateAnswer(loop.answer, loop.returnedIds) : null;
  const citations = validated ? await sourceCitations(db, scope, validated.citations) : [];
  if (!validated) log.warn("question not answered", { org: org.domain, error: loop.error });

  const data = {
    question,
    answerMarkdown: validated?.answerMarkdown ?? NOT_ANSWERED,
    citations: citations as unknown as Prisma.InputJsonValue,
    found: validated?.found ?? false,
    model: loop.calls.find((c) => !c.error)?.model ?? model,
    deep: !!input.deep,
    toolCalls: loop.toolCalls,
    emailsRead: loop.returnedIds.size,
    costUsd,
    error: validated ? null : (loop.error ?? "unknown"),
    createdAt: now,
  };
  const turn = session
    ? await db.chatTurn.create({ data: { ...data, sessionId: session.id } })
    : await db.chatTurn.create({ data: { ...data, session: { create: { orgId: org.id, userId: ctx.userId, title: question.replace(/\s+/g, " ").slice(0, 80) } } } });
  if (session) await db.chatSession.update({ where: { id: session.id }, data: { updatedAt: now } });
  // The audit log records that a question was asked and its text, never the answer.
  await logAudit(db, { orgId: org.id, userEmail: ctx.email, action: "chat.ask", targetType: "chat", targetId: turn.sessionId, after: { question } });

  return {
    ok: true, sessionId: turn.sessionId, turnId: turn.id, answerMarkdown: data.answerMarkdown, citations, found: data.found, unverified: validated?.unverified ?? false, limitHit: loop.limitHit,
    error: data.error, model: data.model, deep: data.deep, costUsd, toolCalls: loop.toolCalls, emailsRead: data.emailsRead,
  };
}
