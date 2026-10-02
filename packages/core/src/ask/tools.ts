/**
 * Read-only retrieval tools the "Ask" chat exposes to Claude.
 *
 * Security lives here, not in the prompt: the company and the mailboxes a tool
 * may read come from the signed-in user's session (`AskScope`) and are never
 * taken from model input. A `mailbox` argument can only narrow the search
 * inside that set, every row is re-checked before it is returned, and no tool
 * can write anything or reach Microsoft Graph.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { formatLocalDate } from "../ai/prompts.js";
import { readBody } from "../crypto.js";
import { Prisma, type PrismaClient } from "../db.js";
import { zonedTimeToUtc } from "../sync/business-hours.js";
import { searchPlans, snippet } from "./text.js";

export interface AskScope {
  orgId: string;
  timezone: string;
  /** every mailbox the user may read in this company */
  mailboxes: { id: string; emailAddress: string }[];
  /** filters chosen in the UI: hard limits the model cannot widen */
  mailboxId: string | null;
  after: Date | null;
  before: Date | null;
  threadId: string | null;
}

export interface ToolOutcome {
  /** JSON text returned to the model */
  content: string;
  isError: boolean;
  /** ids of the emails whose content was shown to the model (the only ids an answer may cite) */
  messageIds: string[];
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const SearchEmailsInput = z.object({
  query: z.string().max(200).optional(),
  from: z.string().max(200).optional(),
  fromDomain: z.string().max(100).regex(/^[a-z0-9.-]+$/i, "a domain like example.com").optional(),
  mailbox: z.string().max(200).optional(),
  after: day.optional(),
  before: day.optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  limit: z.number().int().min(1).max(15).optional(),
});
const SearchThreadsInput = z.object({ query: z.string().min(1).max(200), after: day.optional(), before: day.optional(), limit: z.number().int().min(1).max(10).optional() });
const GetThreadInput = z.object({ threadId: z.string().min(1).max(64), maxMessages: z.number().int().min(1).max(20).optional() });
const GetMessagesInput = z.object({ messageIds: z.array(z.string().min(1).max(64)).min(1).max(10) });

const dayProp = (what: string) => ({ type: "string" as const, description: `${what}, YYYY-MM-DD` });

export const RETRIEVAL_TOOLS: Anthropic.Tool[] = [
  {
    name: "search_emails",
    description:
      "Full-text search over the company's stored emails (subject, sender, recipients, body). Returns up to `limit` compact hits with a short snippet, best match first; copies of one email held by several mailboxes are returned once. Use keywords, names, product names or reference numbers as the query, in the language the emails are likely written in. Omit `query` to list the most recent emails matching the other filters.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a reference number, e.g. \"PO 4512\" or \"import permit DHL\"" },
        from: { type: "string", description: "Exact sender email address" },
        fromDomain: { type: "string", description: "Sender domain, e.g. supplier.com (subdomains included)" },
        mailbox: { type: "string", description: "Limit to one of our mailboxes, by its email address" },
        after: dayProp("Only emails on or after this day"),
        before: dayProp("Only emails on or before this day"),
        direction: { type: "string", enum: ["inbound", "outbound"], description: "inbound = received by us, outbound = sent by us" },
        limit: { type: "integer", description: "1-15, default 8" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_threads",
    description: "Search conversation threads by subject and AI summary. A cheap first pass: each hit has the thread's summary, status and the id of its latest email. Read the thread with get_thread before stating details.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, after: dayProp("Only threads active on or after this day"), before: dayProp("Only threads active on or before this day"), limit: { type: "integer", description: "1-10, default 5" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_thread",
    description: "Read a thread's emails, oldest first, with their text (long threads are shortened: the first and the most recent emails are kept).",
    input_schema: { type: "object", properties: { threadId: { type: "string" }, maxMessages: { type: "integer", description: "1-20, default 10" } }, required: ["threadId"], additionalProperties: false },
  },
  {
    name: "get_messages",
    description: "Read specific emails in full by their messageId (up to 10).",
    input_schema: { type: "object", properties: { messageIds: { type: "array", items: { type: "string" } } }, required: ["messageIds"], additionalProperties: false },
  },
];

const messageSelect = {
  id: true, threadId: true, mailboxId: true, subject: true, fromAddress: true, fromName: true, toAddresses: true, direction: true, receivedAt: true, sentAt: true,
  bodyText: true, bodyEncrypted: true, bodyPreview: true,
} satisfies Prisma.MessageSelect;
type Row = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

const person = (address: string, name: string | null) => (name?.trim() ? `${name.trim()} <${address}>` : address);

function bodyOf(m: Row): string {
  try {
    return readBody(m) ?? m.bodyPreview ?? "";
  } catch {
    return m.bodyPreview ?? "";
  }
}

/** The mailbox ids a call may read: the session's set, narrowed by the UI filter and then by the model's own filter. */
function mailboxIdsFor(scope: AskScope, mailboxArg?: string): string[] {
  const allowed = scope.mailboxId ? scope.mailboxes.filter((m) => m.id === scope.mailboxId) : scope.mailboxes;
  // A mailbox the user cannot read (or a typo) is ignored rather than trusted.
  const narrowed = mailboxArg ? allowed.filter((m) => m.emailAddress === mailboxArg.trim().toLowerCase()) : [];
  return (narrowed.length ? narrowed : allowed).map((m) => m.id);
}

/** The first instant of a YYYY-MM-DD day in the company timezone, or the last one when `endOfDay`. */
export function dayBound(dayString: string, timezone: string, endOfDay: boolean): Date {
  const [y, m, d] = dayString.split("-").map(Number) as [number, number, number];
  return endOfDay ? new Date(zonedTimeToUtc(y, m, d + 1, 0, 0, timezone).getTime() - 1) : zonedTimeToUtc(y, m, d, 0, 0, timezone);
}

function dateRange(scope: AskScope, after?: string, before?: string): { gte?: Date; lte?: Date } {
  const lows = [scope.after, after ? dayBound(after, scope.timezone, false) : null].filter((d): d is Date => !!d);
  const highs = [scope.before, before ? dayBound(before, scope.timezone, true) : null].filter((d): d is Date => !!d);
  return {
    ...(lows.length ? { gte: new Date(Math.max(...lows.map((d) => d.getTime()))) } : {}),
    ...(highs.length ? { lte: new Date(Math.min(...highs.map((d) => d.getTime()))) } : {}),
  };
}

/** Conditions every email search shares. Copies of an email in other mailboxes are skipped when more than one mailbox is searched. */
function emailConditions(scope: AskScope, mailboxIds: string[], range: { gte?: Date; lte?: Date }): Prisma.Sql[] {
  const conds = [Prisma.sql`m."mailboxId" = ANY(${mailboxIds}::text[])`, Prisma.sql`m."isAutoReply" = false`, Prisma.sql`m."exclusionAction" IS NULL`];
  if (mailboxIds.length > 1) conds.push(Prisma.sql`m."duplicateOfId" IS NULL`);
  if (scope.threadId) conds.push(Prisma.sql`m."threadId" = ${scope.threadId}`);
  if (range.gte) conds.push(Prisma.sql`m."receivedAt" >= ${range.gte}`);
  if (range.lte) conds.push(Prisma.sql`m."receivedAt" <= ${range.lte}`);
  return conds;
}

/**
 * Ids of the best emails for one tsquery: text rank with a boost for recent mail
 * (an email from today counts double, the boost halves after about a month).
 * The GIN index on "searchVector" answers the `@@` condition.
 */
export function emailSearchSql(tsquery: string, conds: Prisma.Sql[], limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT m."id" FROM "Message" m
    WHERE m."searchVector" @@ to_tsquery('simple', ${tsquery}) AND ${Prisma.join(conds, " AND ")}
    ORDER BY ts_rank(m."searchVector", to_tsquery('simple', ${tsquery})) * (1 + 1 / (1 + EXTRACT(EPOCH FROM (now() - m."receivedAt")) / 2592000.0)) DESC, m."receivedAt" DESC
    LIMIT ${limit}`;
}

async function searchEmails(db: PrismaClient, scope: AskScope, input: z.infer<typeof SearchEmailsInput>): Promise<ToolOutcome> {
  const limit = input.limit ?? 8;
  const mailboxIds = mailboxIdsFor(scope, input.mailbox);
  const conds = emailConditions(scope, mailboxIds, dateRange(scope, input.after, input.before));
  if (input.from) conds.push(Prisma.sql`m."fromAddress" = ${input.from.trim().toLowerCase()}`);
  if (input.fromDomain) {
    const d = input.fromDomain.toLowerCase();
    conds.push(Prisma.sql`(m."fromAddress" LIKE ${`%@${d}`} OR m."fromAddress" LIKE ${`%.${d}`})`);
  }
  if (input.direction) conds.push(Prisma.sql`m."direction" = ${input.direction}::"Direction"`);

  const ids: string[] = [];
  const plans = input.query ? searchPlans(input.query) : [];
  if (plans.length) {
    for (const plan of plans) {
      if (ids.length >= limit) break;
      const found = await db.$queryRaw<{ id: string }[]>(emailSearchSql(plan, conds, limit));
      for (const r of found) if (!ids.includes(r.id) && ids.length < limit) ids.push(r.id);
    }
  } else {
    const recent = await db.$queryRaw<{ id: string }[]>`SELECT m."id" FROM "Message" m WHERE ${Prisma.join(conds, " AND ")} ORDER BY m."receivedAt" DESC LIMIT ${limit}`;
    ids.push(...recent.map((r) => r.id));
  }

  const rows = await loadMessages(db, scope, ids);
  const hits = rows.map((m) => ({
    messageId: m.id, threadId: m.threadId, subject: m.subject, from: person(m.fromAddress, m.fromName), date: formatLocalDate(m.sentAt && m.direction === "outbound" ? m.sentAt : m.receivedAt, scope.timezone),
    direction: m.direction, mailbox: mailboxAddress(scope, m.mailboxId), snippet: snippet(bodyOf(m), input.query),
  }));
  return { content: JSON.stringify({ hits, note: hits.length ? undefined : "No emails matched. Try other keywords, a reference number alone, or fewer filters." }), isError: false, messageIds: rows.map((m) => m.id) };
}

const mailboxAddress = (scope: AskScope, id: string) => scope.mailboxes.find((m) => m.id === id)?.emailAddress ?? "";

/** Loads emails by id in the given order, dropping anything outside the user's mailboxes (every row is re-checked here). */
async function loadMessages(db: PrismaClient, scope: AskScope, ids: string[]): Promise<Row[]> {
  if (!ids.length) return [];
  const allowed = new Set(mailboxIdsFor(scope));
  const rows = await db.message.findMany({ where: { id: { in: ids }, mailboxId: { in: [...allowed] }, isAutoReply: false, exclusionAction: null, ...(scope.threadId ? { threadId: scope.threadId } : {}) }, select: messageSelect });
  const byId = new Map(rows.filter((m) => allowed.has(m.mailboxId)).map((m) => [m.id, m]));
  return ids.map((id) => byId.get(id)).filter((m): m is Row => !!m);
}

async function searchThreads(db: PrismaClient, scope: AskScope, input: z.infer<typeof SearchThreadsInput>): Promise<ToolOutcome> {
  const limit = input.limit ?? 5;
  const mailboxIds = mailboxIdsFor(scope);
  const range = dateRange(scope, input.after, input.before);
  const conds = [Prisma.sql`t."mailboxId" = ANY(${mailboxIds}::text[])`, Prisma.sql`t."exclusionAction" IS NULL`];
  if (mailboxIds.length > 1) conds.push(Prisma.sql`t."duplicateOfId" IS NULL`);
  if (scope.threadId) conds.push(Prisma.sql`t."id" = ${scope.threadId}`);
  if (range.gte) conds.push(Prisma.sql`t."lastMessageAt" >= ${range.gte}`);
  if (range.lte) conds.push(Prisma.sql`t."firstMessageAt" <= ${range.lte}`);

  const ids: string[] = [];
  for (const plan of searchPlans(input.query)) {
    if (ids.length >= limit) break;
    const found = await db.$queryRaw<{ id: string }[]>`
      SELECT t."id" FROM "Thread" t
      WHERE t."searchVector" @@ to_tsquery('simple', ${plan}) AND ${Prisma.join(conds, " AND ")}
      ORDER BY ts_rank(t."searchVector", to_tsquery('simple', ${plan})) DESC, t."lastMessageAt" DESC LIMIT ${limit}`;
    for (const r of found) if (!ids.includes(r.id) && ids.length < limit) ids.push(r.id);
  }
  const allowed = new Set(mailboxIds);
  const threads = ids.length
    ? await db.thread.findMany({
        where: { id: { in: ids }, mailboxId: { in: mailboxIds } },
        select: { id: true, mailboxId: true, subject: true, status: true, summary: true, nextAction: true, messageCount: true, lastMessageAt: true, messages: { where: { isAutoReply: false, exclusionAction: null }, orderBy: { receivedAt: "desc" }, take: 1, select: { id: true } } },
      })
    : [];
  const byId = new Map(threads.filter((t) => allowed.has(t.mailboxId)).map((t) => [t.id, t]));
  const hits = ids.map((id) => byId.get(id)).filter((t) => !!t).map((t) => ({
    threadId: t.id, subject: t.subject, mailbox: mailboxAddress(scope, t.mailboxId), status: t.status, messages: t.messageCount, lastActivity: formatLocalDate(t.lastMessageAt, scope.timezone),
    summary: t.summary, nextAction: t.nextAction, latestMessageId: t.messages[0]?.id ?? null,
  }));
  return { content: JSON.stringify({ hits, note: hits.length ? undefined : "No threads matched. Try search_emails with other keywords." }), isError: false, messageIds: hits.map((h) => h.latestMessageId).filter((id): id is string => !!id) };
}

const BODY_CHARS = 2000;

function renderMessages(scope: AskScope, rows: Row[], fullIds: Set<string>, maxChars: number, omitted = 0): string {
  // Halve the per-email text until the result fits what is left of the question's token budget.
  for (let cap = BODY_CHARS; ; cap = Math.floor(cap / 2)) {
    const messages = rows.map((m) => {
      const body = bodyOf(m);
      const limit = fullIds.has(m.id) && cap === BODY_CHARS ? body.length : cap;
      return {
        messageId: m.id, threadId: m.threadId, subject: m.subject, from: person(m.fromAddress, m.fromName), to: (m.toAddresses as unknown as { address: string }[]).map((r) => r.address).join(", "),
        date: formatLocalDate(m.sentAt && m.direction === "outbound" ? m.sentAt : m.receivedAt, scope.timezone), direction: m.direction, mailbox: mailboxAddress(scope, m.mailboxId),
        text: body.length > limit ? `${body.slice(0, limit)}… [shortened]` : body,
      };
    });
    const json = JSON.stringify({ messages, ...(omitted ? { omitted: `${omitted} emails in the middle of the thread are not shown` } : {}) });
    if (json.length <= maxChars || cap <= 250) return json;
  }
}

async function getThread(db: PrismaClient, scope: AskScope, input: z.infer<typeof GetThreadInput>, maxChars: number): Promise<ToolOutcome> {
  const maxMessages = input.maxMessages ?? 10;
  const allowed = mailboxIdsFor(scope);
  const thread = await db.thread.findUnique({ where: { id: input.threadId }, select: { id: true, mailboxId: true } });
  if (!thread || !allowed.includes(thread.mailboxId) || (scope.threadId && scope.threadId !== thread.id)) return { content: JSON.stringify({ error: "Thread not found." }), isError: true, messageIds: [] };
  const all = await db.message.findMany({ where: { threadId: thread.id, isAutoReply: false, exclusionAction: null }, orderBy: { receivedAt: "asc" }, select: messageSelect });
  // Long thread: the first email (the original request) and the most recent ones.
  const rows = all.length > maxMessages ? [all[0]!, ...all.slice(all.length - (maxMessages - 1))].slice(0, maxMessages) : all;
  const full = all.length > maxMessages ? new Set([rows[0]!.id, rows[rows.length - 1]!.id]) : new Set<string>();
  return { content: renderMessages(scope, rows, full, maxChars, all.length - rows.length), isError: false, messageIds: rows.map((m) => m.id) };
}

async function getMessages(db: PrismaClient, scope: AskScope, input: z.infer<typeof GetMessagesInput>, maxChars: number): Promise<ToolOutcome> {
  const rows = await loadMessages(db, scope, [...new Set(input.messageIds)]);
  if (!rows.length) return { content: JSON.stringify({ error: "None of these emails were found." }), isError: true, messageIds: [] };
  return { content: renderMessages(scope, rows, new Set(rows.map((m) => m.id)), maxChars), isError: false, messageIds: rows.map((m) => m.id) };
}

export type ToolExecutor = (name: string, input: unknown, maxChars: number) => Promise<ToolOutcome>;

/** Binds the tools to one user's scope. Model input is validated with zod; a bad call comes back as an error result, not an exception. */
export function createToolExecutor(db: PrismaClient, scope: AskScope): ToolExecutor {
  const run = async <T>(schema: z.ZodType<T>, input: unknown, fn: (parsed: T) => Promise<ToolOutcome>): Promise<ToolOutcome> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return fn(parsed.data);
    return { content: JSON.stringify({ error: `Invalid input: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` }), isError: true, messageIds: [] };
  };
  return (name, input, maxChars) => {
    switch (name) {
      case "search_emails": return run(SearchEmailsInput, input, (p) => searchEmails(db, scope, p));
      case "search_threads": return run(SearchThreadsInput, input, (p) => searchThreads(db, scope, p));
      case "get_thread": return run(GetThreadInput, input, (p) => getThread(db, scope, p, maxChars));
      case "get_messages": return run(GetMessagesInput, input, (p) => getMessages(db, scope, p, maxChars));
      default: return Promise.resolve({ content: JSON.stringify({ error: `Unknown tool ${name}` }), isError: true, messageIds: [] });
    }
  };
}
