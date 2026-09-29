/**
 * Business-hours arithmetic in an IANA timezone using only Intl (no DST tables,
 * no dependencies). Minute precision.
 */
export interface BusinessHours {
  /** IANA timezone, e.g. "Asia/Dubai" */
  timezone: string;
  /** Working weekdays, 0 = Sunday … 6 = Saturday */
  workDays: number[];
  /** "HH:MM" local wall-clock */
  workStart: string;
  /** "HH:MM" local wall-clock */
  workEnd: string;
}

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: "Asia/Dubai",
  workDays: [0, 1, 2, 3, 4],
  workStart: "09:00",
  workEnd: "18:00",
};

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0-6
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components of an instant in the given timezone. */
export function localParts(date: Date, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAYS[parts.weekday ?? "Sun"] ?? 0,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset (ms) of the timezone at the given instant: local − UTC. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = localParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Converts a local wall-clock time in `tz` to an instant. Day/month overflow is allowed (e.g. day = 32). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = tzOffsetMs(guess, tz);
  let result = guess - off1;
  const off2 = tzOffsetMs(result, tz);
  if (off2 !== off1) result = guess - off2;
  return new Date(result);
}

function parseHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid time "${s}", expected HH:MM`);
  return { h: Number(m[1]), m: Number(m[2]) };
}

const MAX_DAYS = 800;

interface DayWindow {
  start: Date;
  end: Date;
  isWorkDay: boolean;
  nextMidnight: Date;
}

function dayWindow(instant: Date, bh: BusinessHours): DayWindow {
  const p = localParts(instant, bh.timezone);
  const ws = parseHHMM(bh.workStart);
  const we = parseHHMM(bh.workEnd);
  return {
    start: zonedTimeToUtc(p.year, p.month, p.day, ws.h, ws.m, bh.timezone),
    end: zonedTimeToUtc(p.year, p.month, p.day, we.h, we.m, bh.timezone),
    isWorkDay: bh.workDays.includes(p.weekday),
    nextMidnight: zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, bh.timezone),
  };
}

/**
 * Minutes inside working hours between two instants. A reply at 22:00 to a
 * message received at 20:00 on the same day counts 0; Fri/Sat (default) count 0.
 */
export function businessMinutesBetween(start: Date, end: Date, bh: BusinessHours = DEFAULT_BUSINESS_HOURS): number {
  if (end.getTime() <= start.getTime()) return 0;
  let totalMs = 0;
  let cursor = start;
  for (let i = 0; i < MAX_DAYS; i++) {
    const w = dayWindow(cursor, bh);
    if (w.isWorkDay) {
      const s = Math.max(cursor.getTime(), w.start.getTime());
      const e = Math.min(end.getTime(), w.end.getTime());
      if (e > s) totalMs += e - s;
    }
    if (w.nextMidnight.getTime() >= end.getTime()) break;
    cursor = w.nextMidnight;
  }
  return Math.round(totalMs / 60_000);
}

/**
 * The instant at which `minutes` of business time will have elapsed after `start`.
 * Returns null if the org has no working days (nothing can ever become due).
 */
export function addBusinessMinutes(start: Date, minutes: number, bh: BusinessHours = DEFAULT_BUSINESS_HOURS): Date | null {
  if (!bh.workDays.length) return null;
  let remainingMs = Math.max(0, minutes) * 60_000;
  let cursor = start;
  for (let i = 0; i < MAX_DAYS; i++) {
    const w = dayWindow(cursor, bh);
    if (w.isWorkDay) {
      const s = Math.max(cursor.getTime(), w.start.getTime());
      const available = w.end.getTime() - s;
      if (available > 0) {
        if (remainingMs <= available) return new Date(s + remainingMs);
        remainingMs -= available;
      }
    }
    cursor = w.nextMidnight;
  }
  return null;
}

/** Wall-clock minutes between two instants (never negative). */
export function rawMinutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}
