import { NextResponse } from "next/server";
import { getDb, renewAllSubscriptions } from "@email-tracker/core";
import { cronGuard } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Renews subscriptions expiring within 24h and creates missing ones. */
export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;
  const results = await renewAllSubscriptions(getDb());
  const summary = results.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.action]: (acc[r.action] ?? 0) + 1 }), {});
  return NextResponse.json({ ok: !results.some((r) => r.action === "error"), summary, details: results.map((r) => ({ mailboxId: r.mailboxId, action: r.action, detail: r.detail, expiresAt: r.expiresAt })) });
}
export const POST = GET;
