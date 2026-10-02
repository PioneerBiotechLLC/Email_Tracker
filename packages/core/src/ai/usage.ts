import { getDb } from "../db.js";

export interface UsageRow {
  key: string;
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageReport {
  since: Date;
  total: UsageRow;
  byDay: UsageRow[];
  byModel: UsageRow[];
  /** summary | period_summary | chat */
  byPurpose: UsageRow[];
}

function add(row: UsageRow, r: { error: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }) {
  row.calls += 1;
  if (r.error) row.errors += 1;
  row.inputTokens += r.inputTokens;
  row.outputTokens += r.outputTokens;
  row.cacheReadTokens += r.cacheReadTokens;
  row.cacheWriteTokens += r.cacheWriteTokens;
  row.costUsd += r.costUsd;
}
const blank = (key: string): UsageRow => ({ key, calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });

/** Calls, tokens and cost per day and per model over the last N days. */
export async function usageReport(days: number, orgId?: string): Promise<UsageReport> {
  const db = getDb();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.aiUsage.findMany({ where: { createdAt: { gte: since }, ...(orgId ? { orgId } : {}) }, orderBy: { createdAt: "asc" } });
  const total = blank("total");
  const byDay = new Map<string, UsageRow>();
  const byModel = new Map<string, UsageRow>();
  const byPurpose = new Map<string, UsageRow>();
  for (const r of rows) {
    add(total, r);
    const day = r.createdAt.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, blank(day));
    add(byDay.get(day)!, r);
    const mk = r.batch ? `${r.model} (batch)` : r.model;
    if (!byModel.has(mk)) byModel.set(mk, blank(mk));
    add(byModel.get(mk)!, r);
    if (!byPurpose.has(r.purpose)) byPurpose.set(r.purpose, blank(r.purpose));
    add(byPurpose.get(r.purpose)!, r);
  }
  return { since, total, byDay: [...byDay.values()], byModel: [...byModel.values()], byPurpose: [...byPurpose.values()] };
}
