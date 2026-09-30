import { NextResponse } from "next/server";
import { hasAnthropicKey, summarizeThreads } from "@email-tracker/core";
import { cronGuard } from "@/lib/cron";
import { deadline } from "@/lib/webhook-work";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Summarizes threads whose debounce window has passed, within the daily cap and the time budget. */
export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;
  if (!hasAnthropicKey()) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY not set" }, { status: 200 });
  const started = Date.now();
  const r = await summarizeThreads({ deadlineAt: deadline(50), limit: 200 });
  return NextResponse.json({ ok: true, ...r, ms: Date.now() - started });
}
export const POST = GET;
