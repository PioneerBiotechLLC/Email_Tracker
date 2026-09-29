import "server-only";
import { getDb, inboundStatus, mailboxScope, type Prisma, type SessionContext } from "@email-tracker/core";
import type { Filters } from "@/lib/filters";

const SORTABLE: Record<string, (dir: "asc" | "desc") => Prisma.MessageOrderByWithRelationInput> = {
  receivedAt: (dir) => ({ receivedAt: dir }),
  fromAddress: (dir) => ({ fromAddress: dir }),
  subject: (dir) => ({ subject: dir }),
  repliedAt: (dir) => ({ repliedAt: { sort: dir, nulls: "last" } }),
  responseBusinessMinutes: (dir) => ({ responseBusinessMinutes: { sort: dir, nulls: "last" } }),
  category: (dir) => ({ thread: { category: dir } }),
  priority: (dir) => ({ thread: { priority: dir } }),
};

export function trackerWhere(ctx: SessionContext, f: Filters, now = new Date()): Prisma.MessageWhereInput {
  const threadAnd: Prisma.ThreadWhereInput[] = [];
  if (f.category) threadAnd.push({ category: f.category as Prisma.ThreadWhereInput["category"] });
  if (f.priority) threadAnd.push({ priority: f.priority as Prisma.ThreadWhereInput["priority"] });
  const where: Prisma.MessageWhereInput = {
    ...mailboxScope(ctx, f.mailboxId),
    direction: "inbound",
    isAutoReply: false,
    receivedAt: { gte: f.from, lte: f.to },
  };
  switch (f.status) {
    case "replied": where.repliedAt = { not: null }; break;
    case "waiting": where.repliedAt = null; threadAnd.push({ status: "awaiting_us", OR: [{ overdueAt: null }, { overdueAt: { gt: now } }] }); break;
    case "overdue": where.repliedAt = null; threadAnd.push({ status: "awaiting_us", overdueAt: { lte: now } }); break;
    case "no_reply_needed": where.repliedAt = null; threadAnd.push({ status: { in: ["no_reply_needed", "closed", "awaiting_them"] } }); break;
  }
  if (f.q) {
    where.OR = [
      { subject: { contains: f.q, mode: "insensitive" } },
      { fromAddress: { contains: f.q, mode: "insensitive" } },
      { fromName: { contains: f.q, mode: "insensitive" } },
      { thread: { summary: { contains: f.q, mode: "insensitive" } } },
    ];
  }
  if (threadAnd.length) where.thread = { AND: threadAnd };
  return where;
}

const select = {
  id: true, receivedAt: true, fromAddress: true, fromName: true, subject: true, repliedAt: true, replyMethod: true,
  responseMinutes: true, responseBusinessMinutes: true, threadId: true,
  thread: { select: { status: true, overdueAt: true, category: true, priority: true } },
  repliedBy: { select: { fromAddress: true } },
  mailbox: { select: { emailAddress: true } },
} satisfies Prisma.MessageSelect;

export type TrackerRow = Prisma.MessageGetPayload<{ select: typeof select }> & { status: ReturnType<typeof inboundStatus>; repliedByAddress: string | null };

function decorate(rows: Prisma.MessageGetPayload<{ select: typeof select }>[], now: Date): TrackerRow[] {
  return rows.map((r) => ({
    ...r,
    status: inboundStatus(r, r.thread, now),
    repliedByAddress: r.repliedAt ? (r.repliedBy?.fromAddress ?? r.mailbox.emailAddress) : null,
  }));
}

/** One page of inbound emails (one query for rows with their thread + replying message, one count — no N+1). */
export async function getTrackerPage(ctx: SessionContext, f: Filters, now = new Date()) {
  const db = getDb();
  const where = trackerWhere(ctx, f, now);
  const orderBy = (SORTABLE[f.sort] ?? SORTABLE.receivedAt!)(f.dir);
  const [rows, total] = await db.$transaction([
    db.message.findMany({ where, orderBy: [orderBy, { id: "asc" }], skip: (f.page - 1) * f.pageSize, take: f.pageSize, select }),
    db.message.count({ where }),
  ]);
  return { rows: decorate(rows, now), total, pages: Math.max(1, Math.ceil(total / f.pageSize)) };
}

export const EXPORT_LIMIT = 10_000;

/** The full filtered view for CSV export (capped). */
export async function getTrackerExport(ctx: SessionContext, f: Filters, now = new Date()) {
  const db = getDb();
  const where = trackerWhere(ctx, f, now);
  const orderBy = (SORTABLE[f.sort] ?? SORTABLE.receivedAt!)(f.dir);
  const rows = await db.message.findMany({ where, orderBy: [orderBy, { id: "asc" }], take: EXPORT_LIMIT, select });
  return decorate(rows, now);
}
