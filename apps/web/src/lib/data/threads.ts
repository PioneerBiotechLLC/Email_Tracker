import "server-only";
import { getDb, mailboxScope, type Prisma, type SessionContext } from "@email-tracker/core";
import type { Filters } from "@/lib/filters";

export function threadsWhere(ctx: SessionContext, f: Filters, now = new Date()): Prisma.ThreadWhereInput {
  const where: Prisma.ThreadWhereInput = { ...mailboxScope(ctx, f.mailboxId), lastMessageAt: { gte: f.from, lte: f.to } };
  if (f.category) where.category = f.category as Prisma.ThreadWhereInput["category"];
  if (f.priority) where.priority = f.priority as Prisma.ThreadWhereInput["priority"];
  switch (f.status) {
    case "overdue": where.status = "awaiting_us"; where.overdueAt = { lte: now }; break;
    case "awaiting_us": where.status = "awaiting_us"; break;
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
  lastMessageAt: true, messageCount: true, participants: true, summaryError: true, summaryUpdatedAt: true, summaryMessageCount: true, needsReply: true,
  mailbox: { select: { emailAddress: true } },
} satisfies Prisma.ThreadSelect;
export type ThreadRow = Prisma.ThreadGetPayload<{ select: typeof select }>;

export async function getThreadsPage(ctx: SessionContext, f: Filters, now = new Date()) {
  const db = getDb();
  const where = threadsWhere(ctx, f, now);
  const [rows, total] = await db.$transaction([
    db.thread.findMany({ where, orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }], skip: (f.page - 1) * f.pageSize, take: f.pageSize, select }),
    db.thread.count({ where }),
  ]);
  return { rows, total, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}
