import "server-only";
import { createLogger, getDb, getEnv, relinkRecentCopies, syncMailboxLocked } from "@email-tracker/core";

/** How far back the copy sweep looks: copies arrive within seconds, three days covers retries and outages. */
const RELINK_DAYS = 3;

const log = createLogger("webhook");

/** Incremental sync + reply recompute for one mailbox (runs after the 202 response). AI summaries are made only on request, never here. */
export async function processMailbox(mailboxId: string, opts: { deadlineAt?: Date; reason: string }): Promise<void> {
  const db = getDb();
  const started = Date.now();
  try {
    const stats = await syncMailboxLocked(mailboxId, { deadlineAt: opts.deadlineAt });
    if (!stats) {
      log.info("sync already running; skipped", { mailboxId, reason: opts.reason });
      return;
    }
    // Copies of one email synced in parallel from several mailboxes may have missed each other: link them now.
    const mailbox = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId }, select: { orgId: true } });
    const relinked = await relinkRecentCopies(db, mailbox.orgId, new Date(Date.now() - RELINK_DAYS * 86_400_000));
    log.info("processed", { relinked: relinked.threadsRecomputed, mailboxId, reason: opts.reason, inbox: stats.folders.inbox.upserted, sent: stats.folders.sentitems.upserted, threads: stats.threadsRecomputed, partial: stats.partial, ms: Date.now() - started });
  } catch (err) {
    log.error("processing failed", { mailboxId, reason: opts.reason, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  } finally {
    void db;
  }
}

/**
 * When to stop STARTING work inside one 60-second invocation. Work already under way still finishes after it
 * (the current Graph page, recomputing every thread that page touched), which takes
 * well over 10 seconds while a new mailbox is backfilling, so the budget leaves 25 seconds of headroom.
 */
export const WORK_BUDGET_SECONDS = 35;

export function deadline(seconds = WORK_BUDGET_SECONDS): Date {
  return new Date(Date.now() + seconds * 1000);
}

export function clientState(): string {
  return getEnv().GRAPH_CLIENT_STATE ?? "";
}
