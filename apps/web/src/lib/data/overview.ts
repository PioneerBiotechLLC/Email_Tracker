import "server-only";
import { bucketByDay, computeKpis, COUNTED, getDb, mailboxScope, slowestSenders, type Prisma, type SessionContext } from "@email-tracker/core";
import type { Filters } from "@/lib/filters";

/** `trackFrom`: the company's reply-tracking start; threads waiting since before it are left out even before every thread was recomputed. */
export async function getOverview(ctx: SessionContext, f: Filters, tz: string, now: Date, trackFrom: Date | null) {
  const db = getDb();
  const scope = mailboxScope(ctx, f.mailboxId);
  const waiting: Prisma.ThreadWhereInput = { ...scope, status: "awaiting_us", ...(trackFrom ? { awaitingSince: { gte: trackFrom } } : {}) };
  const [rows, awaiting, overdue, byCategoryRaw, attention] = await Promise.all([
    db.message.findMany({
      // Excluded mail (rules and auto-detected notifications) never counts toward the KPIs.
      where: { ...scope, direction: "inbound", isAutoReply: false, ...COUNTED, receivedAt: { gte: f.from, lte: f.to } },
      select: { receivedAt: true, repliedAt: true, responseMinutes: true, responseBusinessMinutes: true, fromAddress: true },
    }),
    db.thread.count({ where: waiting }),
    db.thread.count({ where: { ...waiting, overdueAt: { lte: now } } }),
    db.thread.groupBy({ by: ["category"], where: waiting, _count: { _all: true } }),
    db.thread.findMany({
      where: { ...waiting, overdueAt: { lte: now } },
      orderBy: { overdueAt: "asc" },
      take: 10,
      select: { id: true, subject: true, awaitingSince: true, overdueAt: true, priority: true, category: true, participants: true, mailbox: { select: { emailAddress: true } } },
    }),
  ]);
  return {
    kpis: computeKpis(rows),
    days: bucketByDay(rows, f.from, f.to, tz),
    slowest: slowestSenders(rows, 5, 2),
    awaiting,
    overdue,
    byCategory: byCategoryRaw.map((c) => ({ category: c.category, count: c._count._all })).sort((a, b) => b.count - a.count),
    attention,
  };
}
