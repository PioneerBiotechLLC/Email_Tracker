import { NextResponse } from "next/server";
import { getDb } from "@email-tracker/core";
import { cronGuard } from "@/lib/cron";
import { deadline, processMailbox } from "@/lib/webhook-work";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Safety-net delta sync for every active mailbox, oldest-synced first. Each
 * mailbox saves progress per page, so a mailbox that hits the deadline resumes
 * on the next run; the remaining mailboxes are picked up then too.
 */
export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;
  const db = getDb();
  const started = Date.now();
  const until = deadline(50);
  const mailboxes = await db.mailbox.findMany({ where: { isActive: true, org: { azureTenantId: { not: null } } }, orderBy: [{ lastSyncedAt: { sort: "asc", nulls: "first" } }], select: { id: true, emailAddress: true } });
  const processed: string[] = [];
  for (const mb of mailboxes) {
    if (Date.now() >= until.getTime()) break;
    await processMailbox(mb.id, { deadlineAt: until, reason: "cron" });
    processed.push(mb.emailAddress);
  }
  return NextResponse.json({ ok: true, mailboxes: mailboxes.length, processed, remaining: mailboxes.length - processed.length, ms: Date.now() - started });
}
export const POST = GET;
