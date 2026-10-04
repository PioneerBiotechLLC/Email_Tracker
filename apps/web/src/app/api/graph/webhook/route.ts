import { after, NextResponse } from "next/server";
import { createLogger, getDb, parseNotifications, subscriptionIds, validationTokenFrom } from "@email-tracker/core";
import { clientState, deadline, processMailbox } from "@/lib/webhook-work";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("webhook");

/** Graph change notifications: validation handshake, clientState check, 202 fast, work after the response. */
export async function POST(req: Request) {
  const token = validationTokenFrom(req.url);
  if (token) return new NextResponse(token, { status: 200, headers: { "Content-Type": "text/plain" } });

  let body: unknown = null;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid json" }, { status: 400 }); }
  const { accepted, rejected } = parseNotifications(body, clientState());
  if (rejected) log.warn("notifications rejected (clientState mismatch)", { rejected });
  if (!accepted.length) return NextResponse.json({ error: "no valid notifications" }, { status: rejected ? 401 : 202 });

  const ids = subscriptionIds(accepted);
  const db = getDb();
  const mailboxes = await db.mailbox.findMany({ where: { subscriptionId: { in: ids }, isActive: true }, select: { id: true, subscriptionId: true } });
  const unknown = ids.filter((id) => !mailboxes.some((m) => m.subscriptionId === id));
  if (unknown.length) log.warn("notifications for unknown subscriptions", { count: unknown.length });

  after(async () => {
    const until = deadline();
    for (const mb of mailboxes) await processMailbox(mb.id, { deadlineAt: until, reason: "webhook" });
  });
  return new NextResponse(null, { status: 202 });
}

export async function GET(req: Request) {
  const token = validationTokenFrom(req.url);
  return token ? new NextResponse(token, { status: 200, headers: { "Content-Type": "text/plain" } }) : new NextResponse("Graph webhook", { status: 200 });
}
