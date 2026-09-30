import "server-only";
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@email-tracker/core";

/** Cron endpoints require `Authorization: Bearer $CRON_SECRET` (GitHub Actions / Vercel Cron). */
export function cronGuard(req: Request): NextResponse | null {
  if (isAuthorizedCron(req.headers.get("authorization"), process.env.CRON_SECRET)) return null;
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export const cronRoute = { runtime: "nodejs" as const, dynamic: "force-dynamic" as const };
