import type { Prisma, PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { normalizeSubject } from "../mail/subject.js";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "./business-hours.js";
import { INTERNAL_SIGNAL, isInternalSender, threadExclusion, type ExclusionAction } from "./exclusions.js";
import { orgSettings, trackingStart } from "../org-settings.js";
import { computeThreadStatus, detectReplies, type ReplyInputMessage, type ReplyResult } from "./replies.js";

export interface Participant {
  address: string;
  name: string | null;
}

interface OrgHours {
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  replySlaHours: number | null;
}

export function businessHoursFor(org: OrgHours): BusinessHours {
  return {
    timezone: org.timezone || DEFAULT_BUSINESS_HOURS.timezone,
    workDays: org.workDays?.length ? org.workDays : DEFAULT_BUSINESS_HOURS.workDays,
    workStart: org.workStart || DEFAULT_BUSINESS_HOURS.workStart,
    workEnd: org.workEnd || DEFAULT_BUSINESS_HOURS.workEnd,
  };
}

export function slaHoursFor(org: OrgHours): number {
  return org.replySlaHours ?? getEnv().REPLY_SLA_HOURS;
}

export function ownerAddresses(mailbox: { emailAddress: string; aliases: string[] }): Set<string> {
  return new Set([mailbox.emailAddress.toLowerCase(), ...mailbox.aliases.map((a) => a.toLowerCase())]);
}

const messageSelect = {
  id: true,
  direction: true,
  receivedAt: true,
  sentAt: true,
  subject: true,
  fromAddress: true,
  fromName: true,
  toAddresses: true,
  ccAddresses: true,
  internetMessageId: true,
  inReplyTo: true,
  references: true,
  isAutoReply: true,
  lastVerb: true,
  lastVerbAt: true,
  repliedAt: true,
  repliedByMessageId: true,
  replyMethod: true,
  responseMinutes: true,
  responseBusinessMinutes: true,
  duplicateOfId: true,
  exclusionAction: true,
  excludedBy: true,
} satisfies Prisma.MessageSelect;

type DbMessage = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

function toReplyInput(m: DbMessage): ReplyInputMessage {
  return {
    id: m.id,
    direction: m.direction,
    fromAddress: m.fromAddress,
    toAddresses: m.toAddresses as unknown as { address: string }[],
    ccAddresses: m.ccAddresses as unknown as { address: string }[],
    internetMessageId: m.internetMessageId,
    inReplyTo: m.inReplyTo,
    references: m.references,
    receivedAt: m.receivedAt,
    sentAt: m.sentAt,
    // Excluded mail is treated like an automatic message: nobody owes it a reply and it never reopens a thread.
    isAutoReply: m.isAutoReply || m.exclusionAction != null,
    lastVerb: m.lastVerb,
    lastVerbAt: m.lastVerbAt,
  };
}

/** `timestamp(3)` literal in UTC (how Prisma stores DateTime), or null. */
const utcTimestamp = (d: Date | null) => (d ? d.toISOString().replace("T", " ").replace("Z", "") : null);

/** Writes the reply fields of several messages in one UPDATE … FROM unnest(…). */
function writeReplyFields(db: PrismaClient, rows: ReplyResult[]): Prisma.PrismaPromise<number> {
  return db.$executeRaw`
    UPDATE "Message" AS m SET
      "repliedAt" = v.replied_at, "repliedByMessageId" = v.replied_by, "replyMethod" = v.method::"ReplyMethod",
      "responseMinutes" = v.raw_minutes, "responseBusinessMinutes" = v.business_minutes
    FROM unnest(
      ${rows.map((r) => r.messageId)}::text[], ${rows.map((r) => utcTimestamp(r.repliedAt))}::timestamp(3)[], ${rows.map((r) => r.repliedByMessageId)}::text[],
      ${rows.map((r) => r.replyMethod)}::text[], ${rows.map((r) => r.responseMinutes)}::int[], ${rows.map((r) => r.responseBusinessMinutes)}::int[]
    ) AS v(id, replied_at, replied_by, method, raw_minutes, business_minutes)
    WHERE m."id" = v.id`;
}

function replyChanged(m: DbMessage, r: ReplyResult): boolean {
  return (
    (m.repliedAt?.getTime() ?? null) !== (r.repliedAt?.getTime() ?? null) ||
    m.repliedByMessageId !== r.repliedByMessageId ||
    m.replyMethod !== r.replyMethod ||
    m.responseMinutes !== r.responseMinutes ||
    m.responseBusinessMinutes !== r.responseBusinessMinutes
  );
}

export interface RecomputeResult {
  threadId: string;
  status: string;
  messagesUpdated: number;
  /** id of the primary thread when this one is a copy (every message is a copy of that thread's messages) */
  duplicateOfId: string | null;
  /** set when every real inbound message of the thread is excluded by a rule or by auto-detection */
  exclusionAction: ExclusionAction | null;
}

/**
 * Sent messages of the company's OTHER mailboxes that belong to this conversation
 * (same conversation id, or headers pointing at one of its Message-IDs). A reply
 * by a colleague to an email we were Cc'd on counts as the reply for us as well.
 */
async function siblingOutbound(db: PrismaClient, orgId: string, mailboxId: string, conversationId: string, messageIds: string[]): Promise<DbMessage[]> {
  return db.message.findMany({
    where: {
      mailbox: { orgId },
      mailboxId: { not: mailboxId },
      direction: "outbound",
      isAutoReply: false,
      duplicateOfId: null,
      OR: [{ conversationId }, ...(messageIds.length ? [{ inReplyTo: { in: messageIds } }, { references: { hasSome: messageIds } }] : [])],
    },
    select: messageSelect,
  });
}

interface PrimaryInfo {
  id: string;
  direction: "inbound" | "outbound";
}

/** The primary rows of this thread's copies (see sync/dedupe.ts), keyed by id. */
async function loadPrimaries(db: PrismaClient, messages: Pick<DbMessage, "duplicateOfId">[]): Promise<Map<string, PrimaryInfo>> {
  const ids = messages.map((m) => m.duplicateOfId).filter((id): id is string => !!id);
  if (!ids.length) return new Map();
  const rows = await db.message.findMany({ where: { id: { in: ids } }, select: { id: true, direction: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export interface CopyMessage {
  id: string;
  internetMessageId: string | null;
  direction: "inbound" | "outbound";
  duplicateOfId: string | null;
}

/**
 * Whether every email of a thread is also in another mailbox's thread: same Message-ID, and the same direction
 * or linked as copies of each other (a colleague's email sent *To* this mailbox is a request here, not a copy).
 */
export function containedIn(self: CopyMessage[], other: CopyMessage[]): boolean {
  if (!self.length) return false;
  const byId = new Map<string, CopyMessage[]>();
  for (const o of other) if (o.internetMessageId) (byId.get(o.internetMessageId) ?? byId.set(o.internetMessageId, []).get(o.internetMessageId)!).push(o);
  return self.every((m) => !!m.internetMessageId && (byId.get(m.internetMessageId) ?? []).some((o) => o.direction === m.direction || m.duplicateOfId === o.id || o.duplicateOfId === m.id));
}

export interface ThreadRank {
  threadId: string;
  messageCount: number;
  mailboxCreatedAt: Date;
}

/** The thread that represents a conversation held by several mailboxes: the largest, then the mailbox registered first. */
const ranksAbove = (a: ThreadRank, b: ThreadRank) =>
  a.messageCount !== b.messageCount ? a.messageCount > b.messageCount : a.mailboxCreatedAt.getTime() !== b.mailboxCreatedAt.getTime() ? a.mailboxCreatedAt < b.mailboxCreatedAt : a.threadId < b.threadId;

/** Of the threads that contain every email of `self`, the one `self` is a copy of (null when `self` represents the conversation). */
export function pickContainingThread(self: ThreadRank, containing: ThreadRank[]): string | null {
  const best = containing.reduce<ThreadRank | null>((acc, t) => (!acc || ranksAbove(t, acc) ? t : acc), null);
  return best && ranksAbove(best, self) ? best.threadId : null;
}

/**
 * The thread in another mailbox of the company that already holds every email of this one (everyone was in
 * To/Cc of the whole conversation), so "All mailboxes" lists the conversation once. Each mailbox gets its own
 * Graph conversation id, so threads are matched by their emails' Message-IDs.
 */
async function containingThread(db: PrismaClient, thread: { id: string; mailboxId: string; orgId: string; mailboxCreatedAt: Date }, messages: CopyMessage[]): Promise<string | null> {
  const ids = [...new Set(messages.map((m) => m.internetMessageId))];
  if (!messages.length || ids.some((id) => !id)) return null;
  const rows = await db.message.findMany({
    where: { internetMessageId: { in: ids as string[] }, mailbox: { orgId: thread.orgId }, mailboxId: { not: thread.mailboxId } },
    select: { id: true, threadId: true, internetMessageId: true, direction: true, duplicateOfId: true },
  });
  const byThread = new Map<string, CopyMessage[]>();
  for (const r of rows) (byThread.get(r.threadId) ?? byThread.set(r.threadId, []).get(r.threadId)!).push(r);
  const containing = [...byThread].filter(([, msgs]) => containedIn(messages, msgs)).map(([id]) => id);
  if (!containing.length) return null;
  const candidates = await db.thread.findMany({ where: { id: { in: containing } }, select: { id: true, messageCount: true, mailbox: { select: { createdAt: true } } } });
  return pickContainingThread(
    { threadId: thread.id, messageCount: messages.length, mailboxCreatedAt: thread.mailboxCreatedAt },
    candidates.map((c) => ({ threadId: c.id, messageCount: c.messageCount, mailboxCreatedAt: c.mailbox.createdAt })),
  );
}

/**
 * Thin DB wrapper around the pure logic: reloads a thread's messages, runs
 * reply detection + status computation, and persists aggregates, per-message
 * reply fields and the thread status. Called after every sync that touches the
 * conversation and by `pnpm replies:recompute`.
 */
export async function recomputeThread(db: PrismaClient, mailboxId: string, conversationId: string): Promise<RecomputeResult | null> {
  const thread = await db.thread.findUnique({
    where: { mailboxId_conversationId: { mailboxId, conversationId } },
    include: { mailbox: { include: { org: true } } },
  });
  if (!thread) return null;

  const messages = await db.message.findMany({
    where: { threadId: thread.id },
    orderBy: { receivedAt: "asc" },
    select: messageSelect,
  });
  if (!messages.length) {
    await db.thread.delete({ where: { id: thread.id } });
    return null;
  }

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const owners = ownerAddresses(thread.mailbox);
  const businessHours = businessHoursFor(thread.mailbox.org);
  const slaHours = slaHoursFor(thread.mailbox.org);

  // Participants
  const seen = new Map<string, Participant>();
  for (const m of messages) {
    const all: Participant[] = [
      { address: m.fromAddress, name: m.fromName },
      ...(m.toAddresses as unknown as Participant[]),
      ...(m.ccAddresses as unknown as Participant[]),
    ];
    for (const p of all) {
      if (!p?.address) continue;
      const key = p.address.toLowerCase();
      const existing = seen.get(key);
      if (!existing) seen.set(key, { address: key, name: p.name ?? null });
      else if (!existing.name && p.name) existing.name = p.name;
    }
  }

  // Reply detection + status (pure). Sent mail of the company's other mailboxes also counts as a reply, and a
  // copy of a colleague's outgoing email (their reply-all that landed here because we were Cc'd) is the
  // company's own mail: nobody is waiting on this mailbox because of it.
  const primaries = await loadPrimaries(db, messages);
  const org = thread.mailbox.org;
  const domains = new Set([org.domain, ...org.domains].map((d) => d.toLowerCase()));
  const internalNoReply = orgSettings(org.settings).internalNoReply;
  const inputs = messages.map((m) => {
    const r = toReplyInput(m);
    if (r.direction === "inbound" && m.duplicateOfId && primaries.get(m.duplicateOfId)?.direction === "outbound") r.direction = "outbound";
    // A colleague writing to the customer (we were Cc'd) is the company answering; between colleagues only, it is
    // excluded as internal mail (see autoSignal) and nobody waits on it.
    if (r.direction === "inbound" && internalNoReply && isInternalSender(m.fromAddress, domains) && [...r.toAddresses, ...r.ccAddresses].some((a) => !isInternalSender(a.address, domains))) {
      r.direction = "outbound";
      r.isAutoReply = false;
    }
    return r;
  });
  const siblings = await siblingOutbound(db, thread.mailbox.orgId, mailboxId, conversationId, messages.map((m) => m.internetMessageId).filter((id): id is string => !!id));
  const replies = detectReplies(inputs, { owners, businessHours, extraOutbound: siblings.map(toReplyInput) });
  const duplicateOfId = await containingThread(db, { id: thread.id, mailboxId, orgId: thread.mailbox.orgId, mailboxCreatedAt: thread.mailbox.createdAt }, messages);
  const realInbound = messages.filter((m, i) => inputs[i]!.direction === "inbound" && !m.isAutoReply);
  const exclusionAction = threadExclusion(realInbound.map((m) => m.exclusionAction));
  // A thread between colleagues only is "internal", not a notification.
  const excludedCategory = realInbound.every((m) => m.excludedBy === INTERNAL_SIGNAL) ? ("internal" as const) : ("notification" as const);
  const computed = computeThreadStatus(
    inputs,
    replies,
    { status: thread.status, needsReply: thread.needsReply, needsReplyDecidedAt: thread.needsReplyDecidedAt, closedAt: thread.closedAt },
    { owners, businessHours, slaHours, trackFrom: trackingStart(thread.mailbox.org) },
  );
  // A thread made only of excluded mail never waits for anyone, whatever we sent into it.
  const status = exclusionAction && computed.status !== "closed" ? { ...computed, status: "no_reply_needed" as const, awaitingSince: null, overdueAt: null } : computed;

  const changedReplies = replies.filter((r, i) => replyChanged(messages[i]!, r));
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  // All changed messages in ONE statement: one UPDATE per email inside the transaction could outlast
  // Prisma's 5-second transaction limit on a long thread over a slow connection.
  if (changedReplies.length) updates.push(writeReplyFields(db, changedReplies));
  updates.push(
    db.thread.update({
      where: { id: thread.id },
      data: {
        subject: first.subject,
        normalizedSubject: normalizeSubject(first.subject),
        firstMessageAt: first.receivedAt,
        lastMessageAt: last.receivedAt,
        messageCount: messages.length,
        participants: Array.from(seen.values()) as unknown as Prisma.InputJsonValue,
        status: status.status,
        awaitingSince: status.awaitingSince,
        overdueAt: status.overdueAt,
        duplicateOfId,
        exclusionAction,
        // Excluded threads are notifications. When a rule is removed the thread goes back to the AI for a real category.
        ...(thread.categoryManual ? {} : exclusionAction ? { category: excludedCategory } : thread.exclusionAction ? { category: "other" as const, summaryMessageCount: 0 } : {}),
        // A reopened thread is no longer closed.
        ...(thread.status === "closed" && status.status !== "closed" ? { closedAt: null, closedBy: null } : {}),
        // A newer inbound message invalidates the previous needsReply decision (user or AI) until the AI re-summarizes.
        ...(status.decisionReset ? { needsReply: true, needsReplyDecidedBy: null, needsReplyDecidedAt: null } : {}),
      },
    }),
  );
  await db.$transaction(updates);
  return { threadId: thread.id, status: status.status, messagesUpdated: changedReplies.length, duplicateOfId, exclusionAction };
}

/**
 * Recomputes the threads of the company's OTHER mailboxes that share one of the
 * given conversation ids (their reply status may depend on mail that just
 * arrived here). Returns how many were recomputed.
 */
export async function recomputeSiblingThreads(db: PrismaClient, orgId: string, mailboxId: string, conversationIds: string[], skip?: Set<string>): Promise<number> {
  let n = 0;
  for (let i = 0; i < conversationIds.length; i += 500) {
    const rows = await db.thread.findMany({
      where: { mailbox: { orgId }, mailboxId: { not: mailboxId }, conversationId: { in: conversationIds.slice(i, i + 500) } },
      select: { mailboxId: true, conversationId: true },
    });
    for (const r of rows) {
      if (skip?.has(`${r.mailboxId}\u0000${r.conversationId}`)) continue;
      await recomputeThread(db, r.mailboxId, r.conversationId);
      n += 1;
    }
  }
  return n;
}

/** Recomputes every thread of a mailbox. Returns counts per resulting status. */
export async function recomputeMailboxThreads(
  db: PrismaClient,
  mailboxId: string,
  onProgress?: (done: number, total: number) => void,
  /** stop once this passes (inside a web request); `partial` tells the caller to finish with `pnpm replies:recompute` */
  deadlineAt?: Date,
  /** threads recomputed at the same time: the work is mostly waiting on the database, so a few in parallel go much faster */
  concurrency = 1,
): Promise<{ threads: number; messagesUpdated: number; byStatus: Record<string, number>; partial: boolean; failed: { conversationId: string; error: string }[] }> {
  const threads = await db.thread.findMany({ where: { mailboxId }, select: { conversationId: true } });
  const byStatus: Record<string, number> = {};
  const failed: { conversationId: string; error: string }[] = [];
  let messagesUpdated = 0;
  let done = 0;
  let next = 0;
  let partial = false;
  const worker = async () => {
    while (next < threads.length) {
      if (deadlineAt && Date.now() >= deadlineAt.getTime()) {
        partial = true;
        return;
      }
      const t = threads[next++]!;
      try {
        const r = await recomputeThread(db, mailboxId, t.conversationId);
        if (r) {
          byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
          messagesUpdated += r.messagesUpdated;
        }
      } catch (err) {
        // One bad thread must not stop the run: it is reported, and a re-run retries it.
        failed.push({ conversationId: t.conversationId, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      }
      done += 1;
      if (onProgress && (done % 100 === 0 || done === threads.length)) onProgress(done, threads.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { threads: done, messagesUpdated, byStatus, partial, failed };
}
