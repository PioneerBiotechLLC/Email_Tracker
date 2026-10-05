import { describe, expect, it } from "vitest";
import { orgSettings, trackingStart } from "./org-settings.js";

describe("trackingStart", () => {
  it("is midnight of the chosen day in the company timezone", () => {
    expect(trackingStart({ settings: { trackRepliesFrom: "2026-10-05" }, timezone: "Asia/Dubai" })).toEqual(new Date("2026-10-04T20:00:00Z"));
  });

  it("is null when unset or malformed, and other settings keep their defaults", () => {
    expect(trackingStart({ settings: {}, timezone: "Asia/Dubai" })).toBeNull();
    expect(trackingStart({ settings: { trackRepliesFrom: "5 Oct" }, timezone: "Asia/Dubai" })).toBeNull();
    expect(orgSettings({ trackRepliesFrom: "2026-10-05" }).autoExclude).toBe(true);
  });
});
