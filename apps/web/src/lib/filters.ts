import { localParts, zonedTimeToUtc } from "@email-tracker/core";

import type { SearchParams } from "./url-params";
export { withParams, type SearchParams } from "./url-params";

export type RangeKey = "7d" | "30d" | "90d" | "custom";

export interface Filters {
  mailboxId: string | null;
  range: RangeKey;
  from: Date;
  to: Date;
  fromDay: string; // YYYY-MM-DD local
  toDay: string;
  category: string | null;
  priority: string | null;
  status: string | null;
  q: string;
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
}

const one = (sp: SearchParams, k: string): string | undefined => {
  const v = sp[k];
  return Array.isArray(v) ? v[0] : v;
};

function localDayString(d: Date, tz: string): string {
  const p = localParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function startOfLocalDay(day: string, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, tz);
}

/** Parses the URL query string into typed filters. Dates are interpreted in the org timezone. */
export function parseFilters(sp: SearchParams, tz: string, now = new Date()): Filters {
  const mailbox = one(sp, "mailbox");
  const rangeRaw = one(sp, "range");
  const range: RangeKey = rangeRaw === "7d" || rangeRaw === "90d" || rangeRaw === "custom" ? rangeRaw : "30d";
  let from: Date;
  let to: Date;
  if (range === "custom") {
    const f = one(sp, "from") ?? localDayString(new Date(now.getTime() - 30 * 86_400_000), tz);
    const t = one(sp, "to") ?? localDayString(now, tz);
    from = startOfLocalDay(f, tz) ?? new Date(now.getTime() - 30 * 86_400_000);
    const toStart = startOfLocalDay(t, tz) ?? now;
    to = new Date(toStart.getTime() + 86_400_000 - 1);
  } else {
    const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
    to = now;
    from = startOfLocalDay(localDayString(new Date(now.getTime() - (days - 1) * 86_400_000), tz), tz) ?? new Date(now.getTime() - days * 86_400_000);
  }
  const page = Math.max(1, Number(one(sp, "page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(10, Number(one(sp, "size") ?? 25) || 25));
  const dirRaw = one(sp, "dir");
  return {
    mailboxId: mailbox && mailbox !== "all" ? mailbox : null,
    range,
    from,
    to,
    fromDay: localDayString(from, tz),
    toDay: localDayString(to, tz),
    category: one(sp, "category") || null,
    priority: one(sp, "priority") || null,
    status: one(sp, "status") || null,
    q: (one(sp, "q") ?? "").trim().slice(0, 200),
    page,
    pageSize,
    sort: one(sp, "sort") ?? "receivedAt",
    dir: dirRaw === "asc" ? "asc" : "desc",
  };
}
