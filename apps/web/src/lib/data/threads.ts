import "server-only";
import { getDb, listVisibility, mailboxScope, type Prisma, type SessionContext } from "@email-tracker/core";
import type { Filters } from "@/lib/filters";
import { exclusionReasons } from "./exclusions";

/** `trackFrom`: the company's reply-tracking start; "waiting" / "overdue" leave out threads waiting since before it. */
export function threadsWhere(ctx: SessionContext, f: Filters, now: Date, trackFrom: Date | null): Prisma.ThreadWhereInput {
  const where: Prisma.ThreadWhereInput = { ...mailboxScope(ctx, f.mailboxId), lastMessageAt: { gte: f.from, lte: f.to }, AND: [listVisibility(f.showExcluded)] };
  if (f.category) where.category = f.category as Prisma.ThreadWhereInput["category"];
  if (f.priority) where.priority = f.priority as Prisma.ThreadWhereInput["priority"];
  switch (f.status) {
    case "overdue": where.status = "awaiting_us"; where.overdueAt = { lte: now }; if (trackFrom) where.awaitingSince = { gte: trackFrom }; break;
    case "awaiting_us": where.status = "awaiting_us"; if (trackFrom) where.awaitingSince = { gte: trackFrom }; break;
    case "awaiting_them": where.status = "awaiting_them"; break;
    case "no_reply_needed": where.status = "no_reply_needed"; break;
    case "closed": where.status = "closed"; break;
    case "summary_pending": where.summary = null; break;
    case "summary_error": where.summaryError = { not: null }; break;
  }
  if (f.q) where.OR = [{ subject: { contains: f.q, mode: "insensitive" } }, { summary: { contains: f.q, mode: "insensitive" } }, { normalizedSubject: { contains: f.q, mode: "insensitive" } }];
  return where;
}

const select = {
  id: true, subject: true, status: true, overdueAt: true, awaitingSince: true, category: true, priority: true, summary: true, nextAction: true,
  lastMessageAt: true, messageCount: true, participants: true, summaryError: true, summaryUpdatedAt: true, summaryMessageCount: true, needsReply: true, exclusionAction: true,
  mailbox: { select: { emailAddress: true } },
} satisfies Prisma.ThreadSelect;
export type ThreadRow = Prisma.ThreadGetPayload<{ select: typeof select }> & { excludedReason: string | null };

export async function getThreadsPage(ctx: SessionContext, f: Filters, now: Date, trackFrom: Date | null) {
  const db = getDb();
  const where = threadsWhere(ctx, f, now, trackFrom);
  const [rows, total] = await db.$transaction([
    db.thread.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }], skip: (f.page - 1) * f.pageSize, take: f.pageSize, select }),
    db.thread.count({ where }),
  ]);
  // Why each excluded thread on this page is excluded (taken from one of its excluded emails).
  const excluded = rows.filter((t) => t.exclusionAction).map((t) => t.id);
  const causes = excluded.length ? await db.message.findMany({ where: { threadId: { in: excluded }, excludedBy: { not: null } }, distinct: ["threadId"], select: { threadId: true, excludedBy: true } }) : [];
  const reasons = await exclusionReasons(causes.map((c) => c.excludedBy));
  const byThread = new Map(causes.map((c) => [c.threadId, reasons.get(c.excludedBy!) ?? null]));
  return { rows: rows.map((t): ThreadRow => ({ ...t, excludedReason: byThread.get(t.id) ?? null })), total, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}
