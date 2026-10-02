import type { PrismaClient } from "../db.js";
import { createLogger } from "../log.js";

const log = createLogger("retention");

export interface RetentionResult {
  orgs: { slug: string; retentionDays: number; messages: number; threads: number }[];
  aiUsage: number;
  auditLogs: number;
  /** "Ask" questions older than their company's retention window */
  chatTurns: number;
}

/**
 * Deletes rows older than each company's retention window — from OUR database
 * only. Mailboxes are never touched (the app has no write permission on them).
 */
export async function purgeExpired(db: PrismaClient, now = new Date()): Promise<RetentionResult> {
  const orgs = await db.organization.findMany({ select: { id: true, slug: true, retentionDays: true } });
  const out: RetentionResult = { orgs: [], aiUsage: 0, auditLogs: 0, chatTurns: 0 };
  for (const org of orgs) {
    const cutoff = new Date(now.getTime() - org.retentionDays * 86_400_000);
    const messages = await db.message.deleteMany({ where: { mailbox: { orgId: org.id }, receivedAt: { lt: cutoff } } });
    // Threads whose messages are all gone
    const threads = await db.thread.deleteMany({ where: { mailbox: { orgId: org.id }, lastMessageAt: { lt: cutoff }, messages: { none: {} } } });
    // Chats follow the same window: old questions go, then the sessions left empty.
    out.chatTurns += (await db.chatTurn.deleteMany({ where: { session: { orgId: org.id }, createdAt: { lt: cutoff } } })).count;
    await db.chatSession.deleteMany({ where: { orgId: org.id, updatedAt: { lt: cutoff }, turns: { none: {} } } });
    out.orgs.push({ slug: org.slug, retentionDays: org.retentionDays, messages: messages.count, threads: threads.count });
  }
  out.aiUsage = (await db.aiUsage.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 400 * 86_400_000) } } })).count;
  out.auditLogs = (await db.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 730 * 86_400_000) } } })).count;
  log.info("retention purge done", { orgs: out.orgs.length, aiUsage: out.aiUsage, auditLogs: out.auditLogs, chatTurns: out.chatTurns });
  return out;
}
