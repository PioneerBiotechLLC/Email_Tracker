import "server-only";
import { createLogger, getDb, getEnv, summarizeThreads, syncMailboxLocked, hasAnthropicKey } from "@email-tracker/core";

const log = createLogger("webhook");

/** Incremental sync + reply recompute + AI summaries for one mailbox (runs after the 202 response). */
export async function processMailbox(mailboxId: string, opts: { deadlineAt?: Date; reason: string }): Promise<void> {
  const db = getDb();
  const started = Date.now();
  try {
    const stats = await syncMailboxLocked(mailboxId, { deadlineAt: opts.deadlineAt });
    if (!stats) {
      log.info("sync already running; skipped", { mailboxId, reason: opts.reason });
      return;
    }
    let ai: { summarized: number; errors: number; skipped: Record<string, number> } | null = null;
    if (stats.touchedConversationIds.length && hasAnthropicKey() && !(opts.deadlineAt && Date.now() >= opts.deadlineAt.getTime())) {
      // Debounced inside summarizeThread: threads with a very recent message are left for the cron run.
      ai = await summarizeThreads({ mailboxId, conversationIds: stats.touchedConversationIds, deadlineAt: opts.deadlineAt });
    }
    log.info("processed", { mailboxId, reason: opts.reason, inbox: stats.folders.inbox.upserted, sent: stats.folders.sentitems.upserted, threads: stats.threadsRecomputed, partial: stats.partial, ai: ai ? { summarized: ai.summarized, errors: ai.errors, skipped: ai.skipped } : "skipped", ms: Date.now() - started });
  } catch (err) {
    log.error("processing failed", { mailboxId, reason: opts.reason, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
  } finally {
    void db;
  }
}

/** Budget for background work inside one serverless invocation (leave headroom under maxDuration). */
export function deadline(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

export function clientState(): string {
  return getEnv().GRAPH_CLIENT_STATE ?? "";
}
