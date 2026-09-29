import { Command } from "commander";
import { disconnectDb, getDb, hasAnthropicKey, planBackfill, runBackfill, summarizeThread, summarizeThreads, usageReport, getEnv, type PrismaClient } from "@email-tracker/core";

const program = new Command().name("ai").description("Claude thread summaries: backfill, live summarize, usage");

async function mailboxIds(db: PrismaClient, email: string): Promise<string[] | undefined> {
  if (email === "all") return undefined;
  const mb = await db.mailbox.findUniqueOrThrow({ where: { emailAddress: email.toLowerCase() } });
  return [mb.id];
}
const usd = (n: number) => `$${n.toFixed(4)}`;
const num = (n: number) => n.toLocaleString("en-US");

program
  .command("backfill")
  .description("Summarize all unsummarized threads via the Message Batches API (50% cheaper). Use --dry-run first.")
  .argument("<email>", "mailbox address or 'all'")
  .option("--limit <n>", "max threads to submit", (v: string) => Number(v))
  .option("--dry-run", "only print the thread count and estimated cost", false)
  .option("--poll-seconds <n>", "how often to poll the batch status", (v: string) => Number(v), 30)
  .action(async (email: string, opts: { limit?: number; dryRun: boolean; pollSeconds: number }) => {
    const db = getDb();
    const env = getEnv();
    const plan = await planBackfill({ mailboxIds: await mailboxIds(db, email), limit: opts.limit });
    const e = plan.estimate;
    console.log(`\nBackfill plan (${email})`);
    console.log(`  threads to summarize:     ${num(e.threads)}${plan.skippedForCap ? `  (+${num(plan.skippedForCap)} held back by AI_MAX_CALLS_PER_DAY=${env.AI_MAX_CALLS_PER_DAY})` : ""}`);
    console.log(`  models:                   ${Object.entries(e.byModel).map(([m, n]) => `${m} ×${num(n)}`).join(", ") || "-"}`);
    console.log(`  estimated input tokens:   ${num(e.inputTokens)}`);
    console.log(`  estimated output tokens:  ${num(e.outputTokens)}`);
    console.log(`  estimated cost (batch):   ${usd(e.costUsd)}   (≈ ${usd(e.threads ? (e.costUsd / e.threads) * 1000 : 0)} per 1,000 threads)`);
    if (opts.dryRun || !e.threads) {
      if (opts.dryRun) console.log("\nDry run — nothing was sent to the API.");
      return;
    }
    if (!hasAnthropicKey()) throw new Error("ANTHROPIC_API_KEY is not set");
    const r = await runBackfill(plan, { pollIntervalMs: opts.pollSeconds * 1000, onStatus: (m) => console.log(`  ${m}`) });
    console.log(`\nDone: ${r.succeeded} summarized, ${r.failed} failed, actual cost ${usd(r.costUsd)} (batch ${r.batchId})`);
    if (r.failed) console.log("Failed threads keep summaryError and will be retried by `pnpm ai:summarize`.");
  });

program
  .command("summarize")
  .description("Live (non-batch) summaries for threads with new messages, respecting the debounce and daily cap")
  .argument("<email>", "mailbox address or 'all'")
  .option("--limit <n>", "max threads", (v: string) => Number(v))
  .action(async (email: string, opts: { limit?: number }) => {
    const db = getDb();
    if (!hasAnthropicKey()) throw new Error("ANTHROPIC_API_KEY is not set");
    const ids = await mailboxIds(db, email);
    const r = await summarizeThreads({ mailboxId: ids?.[0], limit: opts.limit, onResult: (x) => { if (x.outcome === "error") console.log(`  ${x.threadId}: ${x.reason}`); } });
    console.log(`candidates ${r.candidates}, summarized ${r.summarized}, errors ${r.errors}, skipped ${JSON.stringify(r.skipped)}, cost ${usd(r.costUsd)}${r.capReached ? "  [daily cap reached]" : ""}`);
  });

program
  .command("summarize-thread")
  .description("Summarize one thread and print the result as JSON")
  .argument("<threadId>")
  .option("--force", "ignore 'nothing new' and debounce checks", false)
  .action(async (threadId: string, opts: { force: boolean }) => {
    if (!hasAnthropicKey()) throw new Error("ANTHROPIC_API_KEY is not set");
    const r = await summarizeThread(threadId, { force: opts.force });
    console.log(JSON.stringify(r, null, 2));
  });

program
  .command("usage")
  .description("Claude calls, tokens and cost per day and per model")
  .option("--days <n>", "look-back window", (v: string) => Number(v), 30)
  .action(async (opts: { days: number }) => {
    const r = await usageReport(opts.days);
    const line = (row: { key: string; calls: number; errors: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }) =>
      `  ${row.key.padEnd(28)} calls ${String(row.calls).padStart(5)}  err ${String(row.errors).padStart(3)}  in ${num(row.inputTokens).padStart(10)}  out ${num(row.outputTokens).padStart(9)}  cache r/w ${num(row.cacheReadTokens)}/${num(row.cacheWriteTokens)}  ${usd(row.costUsd)}`;
    console.log(`\nAI usage since ${r.since.toISOString().slice(0, 10)}\n`);
    console.log("By day:");
    r.byDay.length ? r.byDay.forEach((d) => console.log(line(d))) : console.log("  (no calls)");
    console.log("\nBy model:");
    r.byModel.forEach((m) => console.log(line(m)));
    console.log("\nTotal:");
    console.log(line(r.total));
    console.log();
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
