import { describe, expect, it } from "vitest";
import { addBusinessMinutes, businessMinutesBetween, DEFAULT_BUSINESS_HOURS, localParts } from "./business-hours.js";

// Dubai is UTC+4, no DST. Sun–Thu 09:00–18:00 by default.
const dxb = (s: string) => new Date(`${s}+04:00`);

describe("businessMinutesBetween (Asia/Dubai, Sun–Thu 09–18)", () => {
  it("same day inside hours", () => {
    expect(businessMinutesBetween(dxb("2026-09-28T10:00:00"), dxb("2026-09-28T12:30:00"))).toBe(150); // Monday
  });
  it("overnight gap counts only working minutes", () => {
    // Mon 17:00 → Tue 10:00 = 60 (to 18:00) + 60 (from 09:00)
    expect(businessMinutesBetween(dxb("2026-09-28T17:00:00"), dxb("2026-09-29T10:00:00"))).toBe(120);
  });
  it("skips Friday and Saturday", () => {
    // Thu 17:00 → Sun 10:00 = 60 + 60, Fri/Sat = 0
    expect(businessMinutesBetween(dxb("2026-10-01T17:00:00"), dxb("2026-10-04T10:00:00"))).toBe(120);
    // Fully inside the weekend
    expect(businessMinutesBetween(dxb("2026-10-02T09:00:00"), dxb("2026-10-03T18:00:00"))).toBe(0);
  });
  it("reply outside hours on the same evening = 0", () => {
    expect(businessMinutesBetween(dxb("2026-09-28T20:00:00"), dxb("2026-09-28T22:00:00"))).toBe(0);
  });
  it("received at night, answered next morning counts from 09:00", () => {
    expect(businessMinutesBetween(dxb("2026-09-28T22:00:00"), dxb("2026-09-29T09:45:00"))).toBe(45);
  });
  it("received before opening counts from opening", () => {
    expect(businessMinutesBetween(dxb("2026-09-28T07:00:00"), dxb("2026-09-28T09:30:00"))).toBe(30);
  });
  it("a full working day is 540 minutes; a full week is 2700", () => {
    expect(businessMinutesBetween(dxb("2026-09-28T00:00:00"), dxb("2026-09-29T00:00:00"))).toBe(540);
    expect(businessMinutesBetween(dxb("2026-09-27T00:00:00"), dxb("2026-10-04T00:00:00"))).toBe(2700);
  });
  it("returns 0 when end <= start", () => {
    expect(businessMinutesBetween(dxb("2026-09-28T12:00:00"), dxb("2026-09-28T11:00:00"))).toBe(0);
  });
  it("respects custom hours and timezone", () => {
    const bh = { timezone: "Europe/London", workDays: [1, 2, 3, 4, 5], workStart: "08:00", workEnd: "16:00" };
    // Fri 15:00 London → Mon 09:00 London = 60 + 60
    expect(businessMinutesBetween(new Date("2026-10-02T15:00:00+01:00"), new Date("2026-10-05T09:00:00+01:00"), bh)).toBe(120);
  });
});

describe("addBusinessMinutes", () => {
  it("adds within the same day", () => {
    expect(addBusinessMinutes(dxb("2026-09-28T10:00:00"), 120)?.toISOString()).toBe(dxb("2026-09-28T12:00:00").toISOString());
  });
  it("rolls over nights and weekends (24 business hours from Thu 16:00 = Tue 13:00)", () => {
    // Thu 16:00→18:00 = 2h, Sun 9h, Mon 9h, Tue 4h → 13:00
    expect(addBusinessMinutes(dxb("2026-10-01T16:00:00"), 24 * 60)?.toISOString()).toBe(dxb("2026-10-06T13:00:00").toISOString());
  });
  it("starts counting at the next opening when outside hours", () => {
    expect(addBusinessMinutes(dxb("2026-10-02T12:00:00"), 60)?.toISOString()).toBe(dxb("2026-10-04T10:00:00").toISOString()); // Fri → Sun
  });
  it("returns null with no working days", () => {
    expect(addBusinessMinutes(dxb("2026-10-02T12:00:00"), 60, { ...DEFAULT_BUSINESS_HOURS, workDays: [] })).toBeNull();
  });
  it("is consistent with businessMinutesBetween", () => {
    const start = dxb("2026-09-30T11:17:00");
    const end = addBusinessMinutes(start, 1000)!;
    expect(businessMinutesBetween(start, end)).toBe(1000);
  });
});

describe("localParts", () => {
  it("reads wall-clock parts in the timezone", () => {
    const p = localParts(new Date("2026-09-28T20:30:00Z"), "Asia/Dubai");
    expect([p.year, p.month, p.day, p.hour, p.minute, p.weekday]).toEqual([2026, 9, 29, 0, 30, 2]);
  });
});
