import "server-only";
import { collectPeriodActivity, getDb, hasAnthropicKey, latestPeriodSummary, periodRange, type SessionContext, type SummaryPeriodKey } from "@email-tracker/core";

/** Live figures for the window plus the most recent stored digest for this scope and period. */
export async function getPeriodSummaryPage(ctx: SessionContext, mailboxId: string | null, period: SummaryPeriodKey, tz: string, now = new Date()) {
  const db = getDb();
  const range = periodRange(period, now, tz);
  const [activity, latest] = await Promise.all([
    collectPeriodActivity(db, { orgId: ctx.orgId, mailboxId, from: range.from, to: range.to, now }),
    latestPeriodSummary(db, ctx.orgId, mailboxId, period),
  ]);
  return { range, stats: activity.stats, latest, aiConfigured: hasAnthropicKey() };
}

export type PeriodSummaryPage = Awaited<ReturnType<typeof getPeriodSummaryPage>>;
