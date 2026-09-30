import { after, NextResponse } from "next/server";
import { createLogger, ensureSubscription, getDb, parseNotifications, validationTokenFrom } from "@email-tracker/core";
import { clientState, deadline, processMailbox } from "@/lib/webhook-work";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("lifecycle");

/** Graph lifecycle notifications: reauthorizationRequired → renew; subscriptionRemoved → recreate; missed → catch-up sync. */
export async function POST(req: Request) {
  const token = validationTokenFrom(req.url);
  if (token) return new NextResponse(token, { status: 200, headers: { "Content-Type": "text/plain" } });
  let body: unknown = null;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const { accepted, rejected } = parseNotifications(body, clientState());
  if (!accepted.length) return NextResponse.json({ error: "no valid notifications" }, { status: rejected ? 401 : 202 });

  after(async () => {
    const db = getDb();
    const until = deadline(50);
    for (const n of accepted) {
      const mb = await db.mailbox.findFirst({ where: { subscriptionId: n.subscriptionId }, select: { id: true } });
      if (!mb) continue;
      log.info("lifecycle event", { mailboxId: mb.id, event: n.lifecycleEvent });
      if (n.lifecycleEvent === "reauthorizationRequired") await ensureSubscription(db, mb.id, { force: true });
      else if (n.lifecycleEvent === "subscriptionRemoved") {
        await db.mailbox.update({ where: { id: mb.id }, data: { subscriptionId: null, subscriptionExpiresAt: null } });
        await ensureSubscription(db, mb.id);
      } else if (n.lifecycleEvent === "missed") await processMailbox(mb.id, { deadlineAt: until, reason: "lifecycle-missed" });
    }
  });
  return new NextResponse(null, { status: 202 });
}
