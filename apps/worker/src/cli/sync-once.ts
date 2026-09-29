import { Command } from "commander";
import { disconnectDb, getDb, syncMailbox } from "@email-tracker/core";

const program = new Command()
  .name("sync-once")
  .description("Run one backfill/incremental sync for a mailbox (Inbox + Sent Items)")
  .argument("<email>", "registered mailbox address, or 'all' for every active mailbox")
  .option("--reset", "ignore saved delta links and re-run the full backfill", false)
  .option("--days <n>", "backfill window in days (default: BACKFILL_DAYS)", (v: string) => Number(v))
  .action(async (email: string, opts: { reset: boolean; days?: number }) => {
    const db = getDb();
    const targets =
      email === "all"
        ? await db.mailbox.findMany({ where: { isActive: true } })
        : [await db.mailbox.findUniqueOrThrow({ where: { emailAddress: email.toLowerCase() } })];
    if (!targets.length) return console.log("No active mailboxes. Use: pnpm mailbox add <email>");

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
      console.log(`  threads recomputed: ${stats.threadsRecomputed}`);
      console.log(`  totals in DB: ${totals[0]} inbound, ${totals[1]} outbound, ${totals[2]} threads`);
      console.log(`  took ${(stats.durationMs / 1000).toFixed(1)}s`);
    }
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
