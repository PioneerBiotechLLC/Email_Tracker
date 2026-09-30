import { describe, expect, it } from "vitest";
import { parseNotifications, subscriptionIds, validationTokenFrom } from "./webhook.js";
import { subscriptionAction, subscriptionExpiry, subscriptionPayload, webhookUrls } from "./subscriptions.js";
import { isAuthorizedCron } from "../cron/auth.js";
import { adminConsentUrl, signConsentState, verifyConsentState } from "../auth/consent.js";

describe("webhook validation", () => {
  it("echoes the validationToken handshake", () => {
    expect(validationTokenFrom("https://x/api/graph/webhook?validationToken=abc%20123")).toBe("abc 123");
    expect(validationTokenFrom("https://x/api/graph/webhook")).toBeNull();
  });
  it("accepts notifications only with the right clientState", () => {
    const body = { value: [
      { subscriptionId: "s1", clientState: "secret", changeType: "created", resource: "users/u/messages/m1" },
      { subscriptionId: "s2", clientState: "WRONG", changeType: "updated" },
      { subscriptionId: "s1", clientState: "secret", changeType: "updated" },
      { clientState: "secret" },
    ] };
    const r = parseNotifications(body, "secret");
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toBe(2);
    expect(subscriptionIds(r.accepted)).toEqual(["s1"]);
  });
  it("rejects everything when our clientState is unset or the body is malformed", () => {
    expect(parseNotifications({ value: [{ subscriptionId: "s1", clientState: "" }] }, "").rejected).toBe(1);
    expect(parseNotifications("nope", "secret")).toEqual({ accepted: [], rejected: 0 });
    expect(parseNotifications({ value: "x" }, "secret").accepted).toEqual([]);
  });
});

describe("subscriptions", () => {
  const now = new Date("2026-09-30T10:00:00Z");
  it("plans create / renew / none", () => {
    expect(subscriptionAction({ isActive: true, subscriptionId: null, subscriptionExpiresAt: null }, now)).toBe("create");
    expect(subscriptionAction({ isActive: true, subscriptionId: "s", subscriptionExpiresAt: new Date("2026-09-30T09:00:00Z") }, now)).toBe("create"); // expired
    expect(subscriptionAction({ isActive: true, subscriptionId: "s", subscriptionExpiresAt: new Date("2026-10-01T09:00:00Z") }, now)).toBe("renew"); // < 24h
    expect(subscriptionAction({ isActive: true, subscriptionId: "s", subscriptionExpiresAt: new Date("2026-10-03T10:00:00Z") }, now)).toBe("none");
    expect(subscriptionAction({ isActive: false, subscriptionId: null, subscriptionExpiresAt: null }, now)).toBe("none");
  });
  it("builds the Graph payload with lifecycle URL and a < 7-day expiry", () => {
    const exp = subscriptionExpiry(now);
    expect(exp.getTime() - now.getTime()).toBeLessThanOrEqual(10_080 * 60_000);
    const p = subscriptionPayload("u1", { notificationUrl: "https://a/api/graph/webhook", lifecycleNotificationUrl: "https://a/api/graph/lifecycle" }, "cs", exp);
    expect(p).toMatchObject({ changeType: "created,updated", resource: "/users/u1/messages", clientState: "cs", lifecycleNotificationUrl: "https://a/api/graph/lifecycle" });
  });
  it("derives webhook URLs from APP_URL and refuses local/http", () => {
    expect(webhookUrls({ APP_URL: "https://tracker.example.com/" })).toEqual({ notificationUrl: "https://tracker.example.com/api/graph/webhook", lifecycleNotificationUrl: "https://tracker.example.com/api/graph/lifecycle" });
    expect(webhookUrls({ GRAPH_WEBHOOK_URL: "https://x.y/api/graph/webhook", APP_URL: "https://other" })?.notificationUrl).toBe("https://x.y/api/graph/webhook");
    expect(webhookUrls({ APP_URL: "http://localhost:3000" })).toBeNull();
    expect(webhookUrls({})).toBeNull();
  });
});

describe("cron auth", () => {
  const secret = "a-very-long-cron-secret-value";
  it("accepts the right bearer token only", () => {
    expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorizedCron(`bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorizedCron(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedCron(secret, secret)).toBe(false);
    expect(isAuthorizedCron(null, secret)).toBe(false);
    expect(isAuthorizedCron(`Bearer short`, "short")).toBe(false); // secret too short to be safe
    expect(isAuthorizedCron(`Bearer x`, undefined)).toBe(false);
  });
});

describe("admin consent state", () => {
  it("round-trips and rejects tampering / expiry", () => {
    const s = signConsentState("org_1", "secret", 1000);
    expect(verifyConsentState(s, "secret", 3600_000, 2000)).toEqual({ orgId: "org_1" });
    expect(verifyConsentState(s, "other", 3600_000, 2000)).toBeNull();
    expect(verifyConsentState(s + "x", "secret", 3600_000, 2000)).toBeNull();
    expect(verifyConsentState(s, "secret", 500, 2000)).toBeNull();
    expect(verifyConsentState("", "secret")).toBeNull();
  });
  it("builds the consent URL for a known tenant or 'organizations'", () => {
    expect(adminConsentUrl({ clientId: "cid", redirectUri: "https://a/api/graph/consent/callback", state: "st", tenantId: "tid" })).toBe("https://login.microsoftonline.com/tid/adminconsent?client_id=cid&redirect_uri=https%3A%2F%2Fa%2Fapi%2Fgraph%2Fconsent%2Fcallback&state=st");
    expect(adminConsentUrl({ clientId: "cid", redirectUri: "https://a/cb", state: "st", tenantId: null })).toContain("/organizations/adminconsent");
  });
});
