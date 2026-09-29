import type { Prisma, PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { normalizeSubject } from "../mail/subject.js";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "./business-hours.js";
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
    isAutoReply: m.isAutoReply,
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

  // Reply detection + status (pure)
  const inputs = messages.map(toReplyInput);
  const replies = detectReplies(inputs, { owners, businessHours });
  const status = computeThreadStatus(
    inputs,
    replies,
    { status: thread.status, needsReply: thread.needsReply, needsReplyDecidedAt: thread.needsReplyDecidedAt, closedAt: thread.closedAt },
    { owners, businessHours, slaHours },
  );

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
        // A reopened thread is no longer closed.
        ...(thread.status === "closed" && status.status !== "closed" ? { closedAt: null, closedBy: null } : {}),
        // A newer inbound message invalidates the previous needsReply decision (user or AI) until the AI re-summarizes.
        ...(status.decisionReset ? { needsReply: true, needsReplyDecidedBy: null, needsReplyDecidedAt: null } : {}),
      },
    }),
  );
  await db.$transaction(updates);
  return { threadId: thread.id, status: status.status, messagesUpdated: updates.length - 1 };
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
