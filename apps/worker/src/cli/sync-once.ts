import { Command } from "commander";
import { disconnectDb, getDb, hasAnthropicKey, summarizeThreads, syncMailbox } from "@email-tracker/core";

/** Which database this run talks to, so "not found" / connection errors are easy to place. */
function dbHint(): string {
  let host = "unknown";
  try { host = new URL(process.env.DATABASE_URL ?? "").hostname || "unknown"; } catch { /* keep unknown */ }
  return `Database: ${host}${host === "localhost" ? " (your LOCAL database; for production run \`cp .env.production .env\` first)" : ""}.`;
}

const program = new Command()
  .name("sync-once")
  .description("Run one backfill/incremental sync for a mailbox (Inbox + Sent Items)")
  .argument("<email>", "registered mailbox address, or 'all' for every active mailbox")
  .option("--reset", "ignore saved delta links and re-run the full backfill", false)
  .option("--days <n>", "backfill window in days (default: BACKFILL_DAYS)", (v: string) => Number(v))
  .option("--no-ai", "skip Claude summaries for the touched threads")
  .action(async (email: string, opts: { reset: boolean; days?: number; ai: boolean }) => {
    const db = getDb();
    const one = email === "all" ? null : await db.mailbox.findUnique({ where: { emailAddress: email.toLowerCase() } });
    if (email !== "all" && !one) {
      console.error(`No mailbox ${email} in this database. Add it first (Companies page → Add mailbox, or \`pnpm mailbox add ${email}\`).\n${dbHint()}`);
      process.exitCode = 1;
      return;
    }
    const targets = one ? [one] : await db.mailbox.findMany({ where: { isActive: true } });
    if (!targets.length) return console.log(`No active mailboxes. Use: pnpm mailbox add <email>\n${dbHint()}`);

    for (const mb of targets) {
      const stats = await syncMailbox(mb.id, { reset: opts.reset, backfillDays: opts.days });
      const inbox = stats.folders.inbox;
      const sent = stats.folders.sentitems;
      const totals = await db.$transaction([
        db.message.count({ where: { mailboxId: mb.id, direction: "inbound" } }),
        db.message.count({ where: { mailboxId: mb.id, direction: "outbound" } }),
        db.thread.count({ where: { mailboxId: mb.id } }),
      ]);
      console.log(`\n${stats.mailbox}`);
      console.log(`  inbox:      ${inbox.upserted} upserted, ${inbox.skippedDrafts} drafts skipped, ${inbox.removed} removed, ${inbox.pages} pages`);
      console.log(`  sent items: ${sent.upserted} upserted, ${sent.skippedDrafts} drafts skipped, ${sent.removed} removed, ${sent.pages} pages`);
      console.log(`  threads recomputed: ${stats.threadsRecomputed}${stats.siblingThreadsRecomputed ? ` (+${stats.siblingThreadsRecomputed} in other mailboxes of the company)` : ""}`);
      if (stats.duplicates) console.log(`  copies of emails already tracked in another mailbox: ${stats.duplicates} (hidden from "All mailboxes")`);
      console.log(`  totals in DB: ${totals[0]} inbound, ${totals[1]} outbound, ${totals[2]} threads`);
      console.log(`  took ${(stats.durationMs / 1000).toFixed(1)}s`);

      if (!opts.ai) continue;
      if (!hasAnthropicKey()) {
        console.log("  AI summaries skipped: ANTHROPIC_API_KEY is not set");
        continue;
      }
      if (!stats.touchedConversationIds.length) continue;
      const ai = await summarizeThreads({ mailboxId: mb.id, conversationIds: stats.touchedConversationIds });
      console.log(`  AI: ${ai.summarized} summarized, ${ai.errors} errors, skipped ${JSON.stringify(ai.skipped)}, cost $${ai.costUsd.toFixed(4)}${ai.capReached ? " [daily cap reached]" : ""}`);
    }
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    console.error(dbHint());
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
