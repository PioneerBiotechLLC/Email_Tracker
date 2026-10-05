const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    cache.set(tz, f);
  }
  return f;
}

function parts(d: Date, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "Tue 29 Sep, 14:05" in the org timezone; adds the year when it isn't the current one. */
export function formatDateTime(d: Date | string | null | undefined, tz: string, now = new Date()): string {
  if (!d) return "–";
  const date = typeof d === "string" ? new Date(d) : d;
  const p = parts(date, tz);
  const year = p.year === parts(now, tz).year ? "" : ` ${p.year}`;
  return `${p.weekday} ${p.day} ${MONTHS[Number(p.month) - 1]}${year}, ${p.hour}:${p.minute}`;
}

/** "29 Sep" / "29 Sep 2025" */
export function formatDate(d: Date | string | null | undefined, tz: string, now = new Date()): string {
  if (!d) return "–";
  const date = typeof d === "string" ? new Date(d) : d;
  const p = parts(date, tz);
  const year = p.year === parts(now, tz).year ? "" : ` ${p.year}`;
  return `${p.day} ${MONTHS[Number(p.month) - 1]}${year}`;
}

/** "1d 3h 20m", "45m", "0m" */
export function formatMinutes(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return "–";
  const m = Math.round(min);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const r = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${r}m`;
  return `${r}m`;
}

/** "3 days", "5 hours", "12 minutes" waited since a date */
export function formatSince(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "–";
  const ms = now.getTime() - (typeof d === "string" ? new Date(d) : d).getTime();
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export function formatPct(n: number | null | undefined): string {
  return n == null ? "–" : `${n.toFixed(n % 1 ? 1 : 0)}%`;
}

/**
 * A stored summary error ("<iso time> <code>: <detail>") in plain language for the page;
 * the technical text goes in `detail` (shown as a tooltip).
 */
export function summaryErrorText(stored: string): { text: string; detail: string } {
  const detail = stored.replace(/^\S+\s/, "");
  const text = /^api_error/.test(detail) ? "The AI service could not be reached. Try again later."
    : detail === "refusal" ? "The AI declined to summarize this thread."
    : /^(invalid_output|no_tool_call|max_tokens)/.test(detail) ? "The AI's answer was incomplete. Try Re-summarize."
    : "The summary could not be made. Try Re-summarize.";
  return { text, detail };
}

export const STATUS_LABEL: Record<string, string> = {
  replied: "Replied ✓",
  waiting: "Awaiting reply",
  overdue: "Overdue",
  no_reply_needed: "No reply needed",
  awaiting_us: "Awaiting our reply",
  awaiting_them: "Waiting on them",
  closed: "Closed",
};

export const CATEGORY_LABEL: Record<string, string> = {
  customer: "Customer", supplier: "Supplier", internal: "Internal", regulatory: "Regulatory", finance: "Finance", newsletter: "Newsletter", notification: "Notification", other: "Other",
};

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
