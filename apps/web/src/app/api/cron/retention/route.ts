import { NextResponse } from "next/server";
import { getDb, purgeExpired } from "@email-tracker/core";
import { cronGuard } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Purges rows older than each company's retention window — database only, never the mailbox. */
export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;
  const r = await purgeExpired(getDb());
  return NextResponse.json({ ok: true, ...r });
}
export const POST = GET;
