"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertSameOrg, getDb, isSummaryPeriod, logAudit, summarizePeriod } from "@email-tracker/core";
import { requireOrgAction } from "@/lib/session";

/**
 * Generates the digest for the chosen mailbox (or all mailboxes) and period, stores it,
 * and returns to the Summary page with the outcome in the query string.
 */
export async function generatePeriodSummary(orgId: string, mailboxId: string | null, period: string) {
  const ctx = await requireOrgAction(orgId, "summary.generate");
  if (!isSummaryPeriod(period)) throw new Error(`Unknown period: ${period}`);
  const db = getDb();
  if (mailboxId) assertSameOrg(ctx, await db.mailbox.findUnique({ where: { id: mailboxId }, select: { orgId: true } }));

  let outcome: string;
  let detail = "";
  try {
    const r = await summarizePeriod({ orgId: ctx.orgId, mailboxId, period, createdBy: ctx.email });
    outcome = r.outcome;
    detail = r.outcome === "summarized" ? `cost $${(r.costUsd ?? 0).toFixed(4)}` : (r.reason ?? "");
  } catch (err) {
    outcome = "error";
    detail = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
  }
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "summary.generate", targetType: mailboxId ? "mailbox" : "organization", targetId: mailboxId ?? ctx.orgId, after: { period, outcome, detail } });
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { slug: true } });
  revalidatePath("/c/[slug]/summary", "page");
  const q = new URLSearchParams({ period, ai: outcome, detail });
  if (mailboxId) q.set("mailbox", mailboxId);
  redirect(`/c/${org.slug}/summary?${q.toString()}`);
}
