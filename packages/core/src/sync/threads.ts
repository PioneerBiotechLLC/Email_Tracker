import type { Prisma, PrismaClient } from "../db.js";
import { normalizeSubject } from "../mail/subject.js";

export interface Participant {
  address: string;
  name: string | null;
}

/**
 * Recomputes a thread's aggregates from its messages. Reply detection and the
 * full status rules live in Phase 2 (replies.ts); here we only keep the naive
 * "who spoke last" status and never override closed / no_reply_needed.
 */
export async function recomputeThread(db: PrismaClient, mailboxId: string, conversationId: string): Promise<void> {
  const thread = await db.thread.findUnique({ where: { mailboxId_conversationId: { mailboxId, conversationId } } });
  if (!thread) return;
  const messages = await db.message.findMany({
    where: { threadId: thread.id },
    orderBy: { receivedAt: "asc" },
    select: {
      direction: true,
      receivedAt: true,
      subject: true,
      fromAddress: true,
      fromName: true,
      toAddresses: true,
      ccAddresses: true,
      isAutoReply: true,
    },
  });
  if (!messages.length) {
    await db.thread.delete({ where: { id: thread.id } });
    return;
  }
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;

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

  const naiveStatus = last.direction === "outbound" ? "awaiting_them" : "awaiting_us";
  const keepStatus = thread.status === "closed" || thread.status === "no_reply_needed";

  await db.thread.update({
    where: { id: thread.id },
    data: {
      subject: first.subject,
      normalizedSubject: normalizeSubject(first.subject),
      firstMessageAt: first.receivedAt,
      lastMessageAt: last.receivedAt,
      messageCount: messages.length,
      participants: Array.from(seen.values()) as unknown as Prisma.InputJsonValue,
      ...(keepStatus ? {} : { status: naiveStatus }),
    },
  });
}
