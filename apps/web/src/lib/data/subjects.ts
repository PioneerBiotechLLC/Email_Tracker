import "server-only";
import { getDb, mailboxScope, worstStatus, type SessionContext } from "@email-tracker/core";
import type { Filters } from "@/lib/filters";

export async function getSubjectGroups(ctx: SessionContext, f: Filters, now = new Date()) {
  const db = getDb();
  const where = { ...mailboxScope(ctx, f.mailboxId), lastMessageAt: { gte: f.from, lte: f.to }, ...(f.q ? { normalizedSubject: { contains: f.q.toLowerCase() } } : {}) };
  const groups = await db.thread.groupBy({
    by: ["normalizedSubject"],
    where,
    _count: { _all: true },
    _sum: { messageCount: true },
    _max: { lastMessageAt: true },
    orderBy: { _max: { lastMessageAt: "desc" } },
    take: 2000,
  });
  const total = groups.length;
  const page = groups.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);
  const threads = page.length
    ? await db.thread.findMany({
        where: { ...where, normalizedSubject: { in: page.map((g) => g.normalizedSubject) } },
        orderBy: { lastMessageAt: "desc" },
        select: { id: true, subject: true, normalizedSubject: true, status: true, overdueAt: true, lastMessageAt: true, messageCount: true, category: true, priority: true, mailbox: { select: { emailAddress: true } } },
      })
    : [];
  const bySubject = new Map<string, typeof threads>();
  for (const t of threads) (bySubject.get(t.normalizedSubject) ?? bySubject.set(t.normalizedSubject, []).get(t.normalizedSubject)!).push(t);
  return {
    total,
    pages: Math.max(1, Math.ceil(total / f.pageSize)),
    groups: page.map((g) => {
      const ts = bySubject.get(g.normalizedSubject) ?? [];
      return { normalizedSubject: g.normalizedSubject, threadCount: g._count._all, messageCount: g._sum.messageCount ?? 0, lastMessageAt: g._max.lastMessageAt, worst: worstStatus(ts, now), threads: ts };
    }),
  };
}
