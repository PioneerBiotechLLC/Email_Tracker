import { NextResponse } from "next/server";
import { getDb, healthReport } from "@email-tracker/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Public health check without secrets: DB, per-company Graph token, sync freshness. */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get("graph") !== "0";
  try {
    const r = await healthReport(getDb(), { checkGraph: deep });
    return NextResponse.json(r, { status: r.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message.slice(0, 120) : "error" }, { status: 503 });
  }
}
