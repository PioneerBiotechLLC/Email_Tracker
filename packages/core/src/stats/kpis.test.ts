import { describe, expect, it } from "vitest";
import { average, bucketByDay, computeKpis, inboundStatus, median, slowestSenders, worstStatus, type InboundRow } from "./kpis.js";

const TZ = "Asia/Dubai";
const row = (p: Partial<Omit<InboundRow, "receivedAt">> & { receivedAt: string }): InboundRow => ({
  repliedAt: null, responseMinutes: null, responseBusinessMinutes: null, fromAddress: "a@x.com", ...p, receivedAt: new Date(p.receivedAt),
});
const replied = (receivedAt: string, biz: number, raw = biz, from = "a@x.com") => row({ receivedAt, repliedAt: new Date(receivedAt), responseBusinessMinutes: biz, responseMinutes: raw, fromAddress: from });

describe("kpis", () => {
  it("median and average", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 10, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(average([2, 4])).toBe(3);
  });
  it("replied % and response times (business and raw)", () => {
    const k = computeKpis([replied("2026-09-28T06:00:00Z", 30, 120), replied("2026-09-28T07:00:00Z", 90, 90), row({ receivedAt: "2026-09-28T08:00:00Z" })]);
    expect(k.received).toBe(3);
    expect(k.replied).toBe(2);
    expect(k.repliedPct).toBe(66.7);
    expect(k.medianBusinessMinutes).toBe(60);
    expect(k.avgBusinessMinutes).toBe(60);
    expect(k.medianRawMinutes).toBe(105);
  });
  it("empty range gives nulls, not NaN", () => {
    const k = computeKpis([]);
    expect(k.repliedPct).toBeNull();
    expect(k.medianBusinessMinutes).toBeNull();
  });
  it("buckets by org-local day, including empty days", () => {
    const b = bucketByDay(
      [replied("2026-09-28T21:00:00Z", 10), row({ receivedAt: "2026-09-29T05:00:00Z" })], // 21:00Z = 01:00 Dubai next day
      new Date("2026-09-28T00:00:00Z"), new Date("2026-09-30T00:00:00Z"), TZ,
    );
    expect(b.map((x) => x.day)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(b[1]).toEqual({ day: "2026-09-29", received: 2, replied: 1, medianBusinessMinutes: 10 });
    expect(b[0]!.received).toBe(0);
  });
  it("slowest senders by company domain with a minimum reply count", () => {
    const rows = [replied("2026-09-28T06:00:00Z", 600, 600, "x@slow.com"), replied("2026-09-28T07:00:00Z", 400, 400, "y@slow.com"), replied("2026-09-28T08:00:00Z", 10, 10, "a@fast.com"), replied("2026-09-28T09:00:00Z", 20, 20, "a@fast.com"), replied("2026-09-28T09:00:00Z", 9999, 9999, "one@once.com")];
    const s = slowestSenders(rows, 5, 2);
    expect(s.map((x) => x.key)).toEqual(["slow.com", "fast.com"]);
    expect(s[0]).toMatchObject({ replies: 2, avgBusinessMinutes: 500, medianBusinessMinutes: 500 });
  });
  it("worst status and inbound status labels", () => {
    const now = new Date("2026-09-29T00:00:00Z");
    expect(worstStatus([{ status: "closed", overdueAt: null }, { status: "awaiting_them", overdueAt: null }], now)).toBe("awaiting_them");
    expect(worstStatus([{ status: "awaiting_us", overdueAt: new Date("2026-09-28T00:00:00Z") }, { status: "awaiting_us", overdueAt: new Date("2026-09-30T00:00:00Z") }], now)).toBe("overdue");
    expect(worstStatus([], now)).toBeNull();
    expect(inboundStatus({ repliedAt: new Date() }, { status: "awaiting_us", overdueAt: null }, now)).toBe("replied");
    expect(inboundStatus({ repliedAt: null }, { status: "awaiting_us", overdueAt: new Date("2026-09-28T00:00:00Z") }, now)).toBe("overdue");
    expect(inboundStatus({ repliedAt: null }, { status: "awaiting_us", overdueAt: new Date("2026-09-30T00:00:00Z") }, now)).toBe("waiting");
    expect(inboundStatus({ repliedAt: null }, { status: "closed", overdueAt: null }, now)).toBe("no_reply_needed");
  });
});
