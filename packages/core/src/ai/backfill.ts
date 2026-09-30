import type Anthropic from "@anthropic-ai/sdk";
import { getDb, type Prisma } from "../db.js";
import { getEnv } from "../env.js";
import { createLogger } from "../log.js";
import { getAnthropic } from "./client.js";
import { estimateCostUsd } from "./pricing.js";
import { applySummaryToThread, buildMessageParams, countCallsToday, parseSummaryResponse, prepareThread, recordUsage, usageFromMessage, type PreparedThread } from "./summarize-thread.js";

const log = createLogger("ai-backfill");

/** Assumed output size per thread for cost previews (summary JSON + low-effort thinking). */
export const EST_OUTPUT_TOKENS = 450;

export interface BackfillPlan {
  items: PreparedThread[];
  skippedForCap: number;
  perOrgRemaining: Record<string, number>;
  estimate: { threads: number; inputTokens: number; outputTokens: number; costUsd: number; byModel: Record<string, number> };
}

export interface PlanOptions {
  mailboxIds?: string[];
  limit?: number;
  now?: Date;
}

/** Selects unsummarized threads (newest first), builds their requests and estimates the batch cost — no API calls. */
export async function planBackfill(opts: PlanOptions = {}): Promise<BackfillPlan> {
  const db = getDb();
  const env = getEnv();
  const now = opts.now ?? new Date();
  // Copies of threads tracked in another mailbox are not summarized; they inherit the primary thread's summary.
  const where: Prisma.ThreadWhereInput = { ...(opts.mailboxIds ? { mailboxId: { in: opts.mailboxIds } } : { mailbox: { isActive: true } }), duplicateOfId: null };
  const rows = await db.thread.findMany({ where, include: { mailbox: { include: { org: true } } }, orderBy: { lastMessageAt: "desc" } });
  const pending = rows.filter((t) => t.messageCount > t.summaryMessageCount && t.messageCount > 0);

  const perOrgRemaining: Record<string, number> = {};
  const items: PreparedThread[] = [];
  let skippedForCap = 0;
  for (const t of pending) {
    if (opts.limit != null && items.length >= opts.limit) break;
    const orgId = t.mailbox.orgId;
    if (perOrgRemaining[orgId] == null) {
      perOrgRemaining[orgId] = Math.max(0, env.AI_MAX_CALLS_PER_DAY - (await countCallsToday(db, orgId, t.mailbox.org.timezone, now)));
    }
    if (perOrgRemaining[orgId]! <= 0) {
      skippedForCap += 1;
      continue;
    }
    perOrgRemaining[orgId] -= 1;
    items.push(await prepareThread(db, t));
  }

  const byModel: Record<string, number> = {};
  let inputTokens = 0;
  let costUsd = 0;
  for (const it of items) {
    inputTokens += it.estimatedInputTokens;
    byModel[it.request.model] = (byModel[it.request.model] ?? 0) + 1;
    costUsd += estimateCostUsd(it.request.model, { inputTokens: it.estimatedInputTokens, outputTokens: EST_OUTPUT_TOKENS, cacheReadTokens: 0, cacheWriteTokens: 0 }, true);
  }
  return { items, skippedForCap, perOrgRemaining, estimate: { threads: items.length, inputTokens, outputTokens: items.length * EST_OUTPUT_TOKENS, costUsd, byModel } };
}

export interface RunOptions {
  client?: Anthropic;
  pollIntervalMs?: number;
  onStatus?: (msg: string) => void;
  now?: Date;
}

export interface RunResult {
  batchId: string | null;
  submitted: number;
  succeeded: number;
  failed: number;
  costUsd: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Submits the plan to the Message Batches API, waits for it, and saves every result. */
export async function runBackfill(plan: BackfillPlan, opts: RunOptions = {}): Promise<RunResult> {
  const db = getDb();
  const env = getEnv();
  const client = opts.client ?? getAnthropic();
  const say = opts.onStatus ?? ((m: string) => log.info(m));
  const byThread = new Map(plan.items.map((it) => [it.threadId, it]));
  if (!plan.items.length) return { batchId: null, submitted: 0, succeeded: 0, failed: 0, costUsd: 0 };

  const batch = await client.messages.batches.create({
    requests: plan.items.map((it) => ({ custom_id: it.threadId, params: buildMessageParams(it.request, env.AI_EFFORT) })),
  });
  say(`batch ${batch.id} submitted with ${plan.items.length} requests`);

  let status = batch;
  while (status.processing_status !== "ended") {
    await sleep(opts.pollIntervalMs ?? 30_000);
    status = await client.messages.batches.retrieve(batch.id);
    const c = status.request_counts;
    say(`batch ${batch.id}: ${status.processing_status} — processing ${c.processing}, succeeded ${c.succeeded}, errored ${c.errored}, expired ${c.expired}`);
  }

  const out: RunResult = { batchId: batch.id, submitted: plan.items.length, succeeded: 0, failed: 0, costUsd: 0 };
  const now = opts.now ?? new Date();
  for await (const result of await client.messages.batches.results(batch.id)) {
    const item = byThread.get(result.custom_id);
    if (!item) continue;
    let error: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let model = item.request.model;
    if (result.result.type === "succeeded") {
      const message = result.result.message;
      usage = usageFromMessage(message.usage);
      model = message.model || model;
      const parsed = parseSummaryResponse(message);
      if (parsed.summary) {
        await applySummaryToThread(db, item.threadId, parsed.summary, model, item.messageCount, now);
        out.succeeded += 1;
      } else error = parsed.error;
    } else if (result.result.type === "errored") {
      error = `batch_error: ${result.result.error.type}`;
    } else error = `batch_${result.result.type}`;

    out.costUsd += await recordUsage(db, item.orgId, item.threadId, [{ ...usage, model, batch: true, error }]);
    if (error) {
      out.failed += 1;
      await db.thread.update({ where: { id: item.threadId }, data: { summaryError: `${now.toISOString()} ${error}`.slice(0, 500) } });
    }
  }
  say(`batch ${batch.id} done: ${out.succeeded} saved, ${out.failed} failed, $${out.costUsd.toFixed(4)}`);
  return out;
}
