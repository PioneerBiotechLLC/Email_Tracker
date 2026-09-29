/**
 * Pure aggregation helpers for the dashboard (unit-tested; the web app feeds
 * them rows straight from Prisma).
 */
import { localParts } from "../sync/business-hours.js";

export interface InboundRow {
  receivedAt: Date;
  repliedAt: Date | null;
  responseMinutes: number | null;
  responseBusinessMinutes: number | null;
  fromAddress: string;
  category?: string | null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function average(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export interface Kpis {
  received: number;
  replied: number;
  repliedPct: number | null;
  medianBusinessMinutes: number | null;
  avgBusinessMinutes: number | null;
  medianRawMinutes: number | null;
  avgRawMinutes: number | null;
}

export function computeKpis(rows: InboundRow[]): Kpis {
  const replied = rows.filter((r) => r.repliedAt);
  const biz = replied.map((r) => r.responseBusinessMinutes).filter((n): n is number => n != null);
  const raw = replied.map((r) => r.responseMinutes).filter((n): n is number => n != null);
  return {
    received: rows.length,
    replied: replied.length,
    repliedPct: rows.length ? Math.round((replied.length / rows.length) * 1000) / 10 : null,
    medianBusinessMinutes: median(biz),
    avgBusinessMinutes: average(biz),
    medianRawMinutes: median(raw),
    avgRawMinutes: average(raw),
  };
}

export interface DayBucket {
  day: string; // YYYY-MM-DD in the org timezone
  received: number;
  replied: number;
  medianBusinessMinutes: number | null;
}

export function dayKey(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** One bucket per local day between from and to (inclusive), with received counts, replied counts (by receipt day) and the median business response time. */
export function bucketByDay(rows: InboundRow[], from: Date, to: Date, tz: string): DayBucket[] {
  const buckets = new Map<string, { received: number; replied: number; biz: number[] }>();
  for (let t = from.getTime(); t <= to.getTime(); t += 86_400_000) {
    buckets.set(dayKey(new Date(t), tz), { received: 0, replied: 0, biz: [] });
  }
  buckets.set(dayKey(to, tz), buckets.get(dayKey(to, tz)) ?? { received: 0, replied: 0, biz: [] });
  for (const r of rows) {
    const b = buckets.get(dayKey(r.receivedAt, tz));
    if (!b) continue;
    b.received += 1;
    if (r.repliedAt) {
      b.replied += 1;
      if (r.responseBusinessMinutes != null) b.biz.push(r.responseBusinessMinutes);
    }
  }
  return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, b]) => ({ day, received: b.received, replied: b.replied, medianBusinessMinutes: median(b.biz) }));
}

export interface SenderStat {
  key: string; // email domain (company) or address
  replies: number;
  avgBusinessMinutes: number;
  medianBusinessMinutes: number;
}

export function senderKey(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : address.toLowerCase();
}

/** Senders/companies we answer slowest, by average business minutes; needs at least `minReplies` answered emails. */
export function slowestSenders(rows: InboundRow[], top = 5, minReplies = 2): SenderStat[] {
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.repliedAt || r.responseBusinessMinutes == null) continue;
    const k = senderKey(r.fromAddress);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r.responseBusinessMinutes);
  }
  return [...groups.entries()]
    .filter(([, xs]) => xs.length >= minReplies)
    .map(([key, xs]) => ({ key, replies: xs.length, avgBusinessMinutes: average(xs)!, medianBusinessMinutes: median(xs)! }))
    .sort((a, b) => b.avgBusinessMinutes - a.avgBusinessMinutes)
    .slice(0, top);
}

export type ThreadStatusName = "awaiting_us" | "awaiting_them" | "no_reply_needed" | "closed";

/** Worst status in a group (for the By Subject view): overdue > awaiting_us > awaiting_them > no_reply_needed > closed. */
export function worstStatus(threads: { status: ThreadStatusName; overdueAt: Date | null }[], now = new Date()): "overdue" | ThreadStatusName | null {
  const rank: Record<string, number> = { overdue: 5, awaiting_us: 4, awaiting_them: 3, no_reply_needed: 2, closed: 1 };
  let worst: string | null = null;
  for (const t of threads) {
    const s = t.status === "awaiting_us" && t.overdueAt && t.overdueAt.getTime() <= now.getTime() ? "overdue" : t.status;
    if (!worst || rank[s]! > rank[worst]!) worst = s;
  }
  return worst as "overdue" | ThreadStatusName | null;
}

/** Status label for one inbound email row in the tracker. */
export function inboundStatus(row: { repliedAt: Date | null }, thread: { status: ThreadStatusName; overdueAt: Date | null }, now = new Date()): "replied" | "waiting" | "overdue" | "no_reply_needed" {
  if (row.repliedAt) return "replied";
  if (thread.status === "awaiting_us") return thread.overdueAt && thread.overdueAt.getTime() <= now.getTime() ? "overdue" : "waiting";
  return "no_reply_needed";
}
