import type { Prisma, PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { normalizeSubject } from "../mail/subject.js";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "./business-hours.js";
import { threadExclusion, type ExclusionAction } from "./exclusions.js";
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
  threadId: string;
  direction: "inbound" | "outbound";
}

/** The primary rows of this thread's copies (see sync/dedupe.ts), keyed by id. */
async function loadPrimaries(db: PrismaClient, messages: Pick<DbMessage, "duplicateOfId">[]): Promise<Map<string, PrimaryInfo>> {
  const ids = messages.map((m) => m.duplicateOfId).filter((id): id is string => !!id);
  if (!ids.length) return new Map();
  const rows = await db.message.findMany({ where: { id: { in: ids } }, select: { id: true, threadId: true, direction: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

/** The single thread whose messages every message of this thread is a copy of, or null. */
function duplicateThreadOf(threadId: string, messages: Pick<DbMessage, "duplicateOfId">[], primaries: Map<string, PrimaryInfo>): string | null {
  if (!messages.length || !messages.every((m) => m.duplicateOfId)) return null;
  const threadIds = new Set(messages.map((m) => primaries.get(m.duplicateOfId!)?.threadId ?? "?"));
  if (threadIds.size !== 1) return null;
  const [target] = threadIds;
  return target && target !== "?" && target !== threadId ? target : null;
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
  const inputs = messages.map((m) => {
    const r = toReplyInput(m);
    if (r.direction === "inbound" && m.duplicateOfId && primaries.get(m.duplicateOfId)?.direction === "outbound") r.direction = "outbound";
    return r;
  });
  const siblings = await siblingOutbound(db, thread.mailbox.orgId, mailboxId, conversationId, messages.map((m) => m.internetMessageId).filter((id): id is string => !!id));
  const replies = detectReplies(inputs, { owners, businessHours, extraOutbound: siblings.map(toReplyInput) });
  const duplicateOfId = duplicateThreadOf(thread.id, messages, primaries);
  const exclusionAction = threadExclusion(messages.filter((m) => m.direction === "inbound" && !m.isAutoReply).map((m) => m.exclusionAction));
  const computed = computeThreadStatus(
    inputs,
    replies,
    { status: thread.status, needsReply: thread.needsReply, needsReplyDecidedAt: thread.needsReplyDecidedAt, closedAt: thread.closedAt },
    { owners, businessHours, slaHours },
  );
  // A thread made only of excluded mail never waits for anyone, whatever we sent into it.
  const status = exclusionAction && computed.status !== "closed" ? { ...computed, status: "no_reply_needed" as const, awaitingSince: null, overdueAt: null } : computed;

  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const r = replies[i]!;
    if (!replyChanged(m, r)) continue;
    updates.push(
      db.message.update({
        where: { id: m.id },
        data: {
          repliedAt: r.repliedAt,
          repliedByMessageId: r.repliedByMessageId,
          replyMethod: r.replyMethod,
          responseMinutes: r.responseMinutes,
          responseBusinessMinutes: r.responseBusinessMinutes,
        },
      }),
    );
  }

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
        ...(thread.categoryManual ? {} : exclusionAction ? { category: "notification" as const } : thread.exclusionAction ? { category: "other" as const, summaryMessageCount: 0 } : {}),
        // A reopened thread is no longer closed.
        ...(thread.status === "closed" && status.status !== "closed" ? { closedAt: null, closedBy: null } : {}),
        // A newer inbound message invalidates the previous needsReply decision (user or AI) until the AI re-summarizes.
        ...(status.decisionReset ? { needsReply: true, needsReplyDecidedBy: null, needsReplyDecidedAt: null } : {}),
      },
    }),
  );
  await db.$transaction(updates);
  return { threadId: thread.id, status: status.status, messagesUpdated: updates.length - 1, duplicateOfId, exclusionAction };
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
): Promise<{ threads: number; messagesUpdated: number; byStatus: Record<string, number> }> {
  const threads = await db.thread.findMany({ where: { mailboxId }, select: { conversationId: true } });
  const byStatus: Record<string, number> = {};
  let messagesUpdated = 0;
  let done = 0;
  for (const t of threads) {
    const r = await recomputeThread(db, mailboxId, t.conversationId);
    if (r) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      messagesUpdated += r.messagesUpdated;
    }
    done += 1;
    if (onProgress && (done % 100 === 0 || done === threads.length)) onProgress(done, threads.length);
  }
  return { threads: threads.length, messagesUpdated, byStatus };
}
