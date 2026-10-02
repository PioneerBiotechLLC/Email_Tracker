import type Anthropic from "@anthropic-ai/sdk";
import { readBody } from "../crypto.js";
import { getDb, type Prisma, type PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { createLogger } from "../log.js";
import { localParts, zonedTimeToUtc } from "../sync/business-hours.js";
import { effectiveTime } from "../sync/replies.js";
import { recomputeThread } from "../sync/threads.js";
import { getAnthropic, supportsEffort } from "./client.js";
import { estimateCostUsd, type TokenUsage } from "./pricing.js";
import { buildThreadInput, systemPrompt, userMessage, type InputMessage, type SummaryLanguage } from "./prompts.js";
import { SUMMARY_TOOL, SUMMARY_TOOL_NAME, ThreadSummarySchema, type ThreadSummary } from "./schema.js";

const log = createLogger("ai");

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a DB or the API)

export type SkipReason = "nothing_new" | "debounce" | "cap_reached" | "duplicate" | "duplicate_copied" | "excluded";

export interface SkipInput {
  messageCount: number;
  summaryMessageCount: number;
  lastMessageAt: Date;
  now: Date;
  debounceMinutes: number;
  callsToday: number;
  maxCallsPerDay: number;
  force?: boolean;
}

/** Why a thread should not be summarized right now, or null to proceed. The cap always applies. */
export function decideSkip(i: SkipInput): SkipReason | null {
  if (i.callsToday >= i.maxCallsPerDay) return "cap_reached";
  if (i.force) return null;
  if (i.messageCount <= i.summaryMessageCount) return "nothing_new";
  if (i.now.getTime() - i.lastMessageAt.getTime() < i.debounceMinutes * 60_000) return "debounce";
  return null;
}

export interface DecisionState {
  needsReply: boolean;
  needsReplyDecidedBy: "user" | "ai" | null;
}

/**
 * The AI's needs_reply only applies when a user hasn't decided. (A user decision
 * is cleared automatically by the status logic when a newer inbound arrives.)
 */
export function applyNeedsReplyDecision(current: DecisionState, summary: Pick<ThreadSummary, "needs_reply">): DecisionState {
  if (current.needsReplyDecidedBy === "user") return current;
  return { needsReply: summary.needs_reply, needsReplyDecidedBy: "ai" };
}

/** concluded → closed only when the thread is not waiting on us and not already closed. */
export function shouldCloseAsConcluded(summary: Pick<ThreadSummary, "concluded">, statusAfterRecompute: string): boolean {
  return summary.concluded && statusAfterRecompute !== "awaiting_us" && statusAfterRecompute !== "closed";
}

/** Uses the light model for 1–2 short messages when one is configured. */
export function chooseModel(messageCount: number, inputChars: number, env: { ANTHROPIC_MODEL: string; ANTHROPIC_MODEL_LIGHT?: string | undefined }): string {
  if (env.ANTHROPIC_MODEL_LIGHT && messageCount <= 2 && inputChars <= 1500) return env.ANTHROPIC_MODEL_LIGHT;
  return env.ANTHROPIC_MODEL;
}

export interface CallResult {
  summary: ThreadSummary | null;
  error: string | null;
  usage: TokenUsage;
  model: string;
  stopReason: string | null;
}

export function usageFromMessage(u: Anthropic.Usage | undefined): TokenUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Extracts and validates the tool call from a response. Never throws. */
export function parseSummaryResponse(message: Anthropic.Message): { summary: ThreadSummary | null; error: string | null } {
  if (message.stop_reason === "refusal") return { summary: null, error: "refusal" };
  if (message.stop_reason === "max_tokens") return { summary: null, error: "max_tokens" };
  const call = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === SUMMARY_TOOL_NAME);
  if (!call) return { summary: null, error: "no_tool_call" };
  const parsed = ThreadSummarySchema.safeParse(call.input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { summary: null, error: `invalid_output: ${issues}` };
  }
  return { summary: parsed.data, error: null };
}

export interface SummaryRequest {
  model: string;
  system: string;
  user: string;
}

/** Request params shared by live calls and the Batch API. */
export function buildMessageParams(req: SummaryRequest, effort: "low" | "medium" | "high"): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: req.model,
    max_tokens: 4096,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: req.user }],
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    ...(supportsEffort(req.model) ? { output_config: { effort } } : {}),
  };
}

export type SummaryClient = Pick<Anthropic, "messages">;

/** One live call. API errors are returned, not thrown (the SDK already retried 429/529/5xx). */
export async function callSummary(client: SummaryClient, req: SummaryRequest, effort: "low" | "medium" | "high"): Promise<CallResult> {
  try {
    const message = await client.messages.create(buildMessageParams(req, effort));
    const { summary, error } = parseSummaryResponse(message);
    return { summary, error, usage: usageFromMessage(message.usage), model: message.model || req.model, stopReason: message.stop_reason };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const msg = err instanceof Error ? err.message : String(err);
    return { summary: null, error: `api_error${status ? ` ${status}` : ""}: ${msg.slice(0, 300)}`, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: req.model, stopReason: null };
  }
}

/** Calls once; retries once more only when the output was invalid/missing (not for API errors — the SDK handled those). */
export async function summarizeWithRetry(client: SummaryClient, req: SummaryRequest, effort: "low" | "medium" | "high"): Promise<{ summary: ThreadSummary | null; error: string | null; calls: CallResult[] }> {
  const calls: CallResult[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await callSummary(client, req, effort);
    calls.push(r);
    if (r.summary) return { summary: r.summary, error: null, calls };
    const retryable = r.error?.startsWith("invalid_output") || r.error === "no_tool_call" || r.error === "max_tokens";
    if (!retryable) return { summary: null, error: r.error, calls };
  }
  return { summary: null, error: calls[calls.length - 1]!.error, calls };
}

// ---------------------------------------------------------------------------
// DB-backed job

const threadInclude = { mailbox: { include: { org: true } } } satisfies Prisma.ThreadInclude;
type ThreadWithOrg = Prisma.ThreadGetPayload<{ include: typeof threadInclude }>;

const messageSelect = {
  direction: true, fromAddress: true, fromName: true, toAddresses: true, ccAddresses: true,
  receivedAt: true, sentAt: true, subject: true, bodyText: true, bodyEncrypted: true, bodyPreview: true, isAutoReply: true, exclusionAction: true,
} satisfies Prisma.MessageSelect;
type DbMsg = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

function toInputMessage(m: DbMsg): InputMessage {
  return {
    direction: m.direction,
    fromAddress: m.fromAddress,
    fromName: m.fromName,
    toAddresses: m.toAddresses as unknown as InputMessage["toAddresses"],
    ccAddresses: m.ccAddresses as unknown as InputMessage["ccAddresses"],
    at: effectiveTime(m),
    subject: m.subject,
    text: readBody(m) ?? m.bodyPreview ?? "",
    isAutoReply: m.isAutoReply,
  };
}

export interface PreparedThread {
  threadId: string;
  orgId: string;
  request: SummaryRequest;
  estimatedInputTokens: number;
  messageCount: number;
}

/** Loads a thread's messages and builds the exact request that will be sent (also used by dry-runs). */
export async function prepareThread(db: PrismaClient, thread: ThreadWithOrg): Promise<PreparedThread> {
  const env = getEnv();
  const rows = await db.message.findMany({ where: { threadId: thread.id }, orderBy: { receivedAt: "asc" }, select: messageSelect });
  // Excluded mail (notifications inside a real conversation) is never sent to the AI.
  const messages = rows.filter((m) => !m.exclusionAction).map(toInputMessage);
  const tz = thread.mailbox.org.timezone;
  const input = buildThreadInput(messages, { timezone: tz });
  const lang: SummaryLanguage = thread.mailbox.org.summaryLanguage === "ar" ? "ar" : "en";
  const system = systemPrompt(lang, thread.mailbox.org.aiContext);
  const user = userMessage({ subject: thread.subject, mailboxAddress: thread.mailbox.emailAddress, orgName: thread.mailbox.org.name, timezone: tz }, input);
  const model = chooseModel(messages.length, input.text.length, env);
  return {
    threadId: thread.id,
    orgId: thread.mailbox.orgId,
    request: { model, system, user },
    estimatedInputTokens: input.estimatedTokens + Math.ceil(system.length / 3.5) + 150,
    messageCount: rows.length,
  };
}

/** Start of the org's local day, for the daily cap. */
export function startOfLocalDay(now: Date, tz: string): Date {
  const p = localParts(now, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

export async function countCallsToday(db: PrismaClient, orgId: string, tz: string, now = new Date()): Promise<number> {
  return db.aiUsage.count({ where: { orgId, createdAt: { gte: startOfLocalDay(now, tz) } } });
}

export interface UsageRecordInput extends TokenUsage {
  model: string;
  batch: boolean;
  error: string | null;
}

export async function recordUsage(db: PrismaClient, orgId: string, threadId: string | null, records: UsageRecordInput[]): Promise<number> {
  if (!records.length) return 0;
  let total = 0;
  await db.aiUsage.createMany({
    data: records.map((r) => {
      const costUsd = estimateCostUsd(r.model, r, r.batch);
      total += costUsd;
      return { orgId, threadId, model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens, costUsd, batch: r.batch, error: r.error };
    }),
  });
  return total;
}

/** Persists a validated summary, applies the needs-reply / concluded rules, and recomputes status. */
export async function applySummaryToThread(db: PrismaClient, threadId: string, summary: ThreadSummary, model: string, messageCount: number, now = new Date()): Promise<{ status: string }> {
  const thread = await db.thread.findUniqueOrThrow({ where: { id: threadId }, select: { mailboxId: true, conversationId: true, needsReply: true, needsReplyDecidedBy: true, categoryManual: true, priorityManual: true } });
  const decision = applyNeedsReplyDecision(thread, summary);
  await db.thread.update({
    where: { id: threadId },
    data: {
      summary: summary.summary,
      keyPoints: summary.key_points,
      asks: summary.asks as unknown as Prisma.InputJsonValue,
      nextAction: summary.next_action,
      // Manual classifications set in the dashboard win over the AI.
      ...(thread.categoryManual ? {} : { category: summary.category }),
      ...(thread.priorityManual ? {} : { priority: summary.priority }),
      summaryLang: summary.language,
      summaryUpdatedAt: now,
      summaryMessageCount: messageCount,
      summaryModel: model,
      summaryError: null,
      needsReply: decision.needsReply,
      needsReplyDecidedBy: decision.needsReplyDecidedBy,
      needsReplyDecidedAt: now,
    },
  });
  const r = await recomputeThread(db, thread.mailboxId, thread.conversationId);
  let status = r?.status ?? "unknown";
  if (shouldCloseAsConcluded(summary, status)) {
    await db.thread.update({ where: { id: threadId }, data: { status: "closed", closedAt: now, closedBy: "ai", awaitingSince: null, overdueAt: null } });
    status = "closed";
  }
  await propagateSummaryToDuplicates(db, threadId, now);
  return { status };
}

/**
 * Copies a thread's summary to the threads that are copies of it (the same emails
 * tracked in another mailbox of the company because it was Cc'd). No API call.
 * Returns the number of threads updated.
 */
export async function propagateSummaryToDuplicates(db: PrismaClient, primaryThreadId: string, now = new Date(), onlyThreadId?: string): Promise<number> {
  const src = await db.thread.findUnique({
    where: { id: primaryThreadId },
    select: { summary: true, keyPoints: true, asks: true, nextAction: true, category: true, priority: true, summaryLang: true, summaryModel: true, needsReply: true },
  });
  if (!src?.summary) return 0;
  const copies = await db.thread.findMany({
    where: { duplicateOfId: primaryThreadId, ...(onlyThreadId ? { id: onlyThreadId } : {}) },
    select: { id: true, mailboxId: true, conversationId: true, messageCount: true, categoryManual: true, priorityManual: true, needsReplyDecidedBy: true },
  });
  for (const c of copies) {
    await db.thread.update({
      where: { id: c.id },
      data: {
        summary: src.summary,
        keyPoints: (src.keyPoints ?? []) as Prisma.InputJsonValue,
        asks: (src.asks ?? []) as Prisma.InputJsonValue,
        nextAction: src.nextAction,
        ...(c.categoryManual ? {} : { category: src.category }),
        ...(c.priorityManual ? {} : { priority: src.priority }),
        summaryLang: src.summaryLang,
        summaryUpdatedAt: now,
        summaryMessageCount: c.messageCount,
        summaryModel: src.summaryModel,
        summaryError: null,
        ...(c.needsReplyDecidedBy === "user" ? {} : { needsReply: src.needsReply, needsReplyDecidedBy: "ai" as const, needsReplyDecidedAt: now }),
      },
    });
    await recomputeThread(db, c.mailboxId, c.conversationId);
  }
  return copies.length;
}

export interface SummarizeOptions {
  force?: boolean;
  client?: SummaryClient;
  now?: Date;
}

export interface SummarizeResult {
  threadId: string;
  outcome: "summarized" | "skipped" | "error";
  reason?: string;
  model?: string;
  costUsd?: number;
  status?: string;
  summary?: ThreadSummary;
}

/** Summarizes one thread live (SPEC §7). Never throws for model/validation problems. */
export async function summarizeThread(threadId: string, opts: SummarizeOptions = {}): Promise<SummarizeResult> {
  const db = getDb();
  const env = getEnv();
  const now = opts.now ?? new Date();
  const thread = await db.thread.findUnique({ where: { id: threadId }, include: threadInclude });
  if (!thread) return { threadId, outcome: "error", reason: "not_found" };
  const org = thread.mailbox.org;

  // A copy of a thread tracked in another mailbox: reuse that thread's summary instead of paying for it twice.
  if (thread.duplicateOfId) {
    const copied = await propagateSummaryToDuplicates(db, thread.duplicateOfId, now, thread.id);
    return { threadId, outcome: "skipped", reason: copied ? "duplicate_copied" : "duplicate" };
  }
  // Every inbound message is excluded (notifications, newsletters, ignored senders): no AI call, even when forced.
  if (thread.exclusionAction) return { threadId, outcome: "skipped", reason: "excluded" };

  const callsToday = await countCallsToday(db, org.id, org.timezone, now);
  const skip = decideSkip({
    messageCount: thread.messageCount,
    summaryMessageCount: thread.summaryMessageCount,
    lastMessageAt: thread.lastMessageAt,
    now,
    debounceMinutes: env.AI_SUMMARY_DEBOUNCE_MINUTES,
    callsToday,
    maxCallsPerDay: env.AI_MAX_CALLS_PER_DAY,
    force: opts.force,
  });
  if (skip) {
    if (skip === "cap_reached") log.warn("daily AI call cap reached; leaving threads for the next run", { org: org.domain, cap: env.AI_MAX_CALLS_PER_DAY });
    return { threadId, outcome: "skipped", reason: skip };
  }

  const prepared = await prepareThread(db, thread);
  const client = opts.client ?? getAnthropic();
  const { summary, error, calls } = await summarizeWithRetry(client, prepared.request, env.AI_EFFORT);
  const costUsd = await recordUsage(db, org.id, thread.id, calls.map((c) => ({ ...c.usage, model: c.model, batch: false, error: c.error })));
  log.debug("summary call", { threadId, model: prepared.request.model, attempts: calls.length, inputTokensEst: prepared.estimatedInputTokens, error });

  if (!summary) {
    await db.thread.update({ where: { id: thread.id }, data: { summaryError: `${now.toISOString()} ${error ?? "unknown"}`.slice(0, 500) } });
    log.warn("summary failed", { threadId, error });
    return { threadId, outcome: "error", reason: error ?? "unknown", model: prepared.request.model, costUsd };
  }
  const { status } = await applySummaryToThread(db, thread.id, summary, prepared.request.model, prepared.messageCount, now);
  return { threadId, outcome: "summarized", model: prepared.request.model, costUsd, status, summary };
}

export interface SummarizeManyOptions extends SummarizeOptions {
  mailboxId?: string;
  orgId?: string;
  /** stop before this time (serverless limits); remaining threads wait for the next run */
  deadlineAt?: Date;
  /** restrict to these conversation ids (e.g. the ones a sync just touched) */
  conversationIds?: string[];
  limit?: number;
  onResult?: (r: SummarizeResult) => void;
}

export interface SummarizeManyResult {
  candidates: number;
  summarized: number;
  skipped: Record<string, number>;
  errors: number;
  costUsd: number;
  capReached: boolean;
}

/** Live summarization for every thread with new messages. Stops at the daily cap. */
export async function summarizeThreads(opts: SummarizeManyOptions = {}): Promise<SummarizeManyResult> {
  const db = getDb();
  const where: Prisma.ThreadWhereInput = {
    ...(opts.mailboxId ? { mailboxId: opts.mailboxId } : { mailbox: { isActive: true, ...(opts.orgId ? { orgId: opts.orgId } : {}) } }),
    ...(opts.conversationIds ? { conversationId: { in: opts.conversationIds } } : {}),
    exclusionAction: null,
  };
  // Prisma can't compare two columns; filter messageCount > summaryMessageCount in JS.
  const rows = await db.thread.findMany({ where, select: { id: true, messageCount: true, summaryMessageCount: true }, orderBy: { lastMessageAt: "asc" } });
  const candidates = rows.filter((t) => opts.force || t.messageCount > t.summaryMessageCount).slice(0, opts.limit ?? Number.MAX_SAFE_INTEGER);

  const out: SummarizeManyResult = { candidates: candidates.length, summarized: 0, skipped: {}, errors: 0, costUsd: 0, capReached: false };
  for (const t of candidates) {
    if (opts.deadlineAt && Date.now() >= opts.deadlineAt.getTime()) break;
    const r = await summarizeThread(t.id, opts);
    opts.onResult?.(r);
    if (r.outcome === "summarized") out.summarized += 1;
    else if (r.outcome === "error") out.errors += 1;
    else out.skipped[r.reason ?? "?"] = (out.skipped[r.reason ?? "?"] ?? 0) + 1;
    out.costUsd += r.costUsd ?? 0;
    if (r.reason === "cap_reached") {
      out.capReached = true;
      break;
    }
  }
  return out;
}
