import { describe, expect, it } from "vitest";
import { isValidSlug, pickOrg, resolveOrgRole, slugify, visibleOrgs } from "./membership.js";

const orgs = [
  { id: "a", slug: "api-pharma", isDemo: false },
  { id: "b", slug: "pioneer-biotech", isDemo: false },
  { id: "d", slug: "demo-pharma", isDemo: true },
];

describe("membership scoping", () => {
  it("a user without membership for company B has no role there (→ 404)", () => {
    const user = { isOwner: false, memberships: [{ orgId: "a", role: "admin" as const }] };
    expect(resolveOrgRole(user, "a")).toBe("admin");
    expect(resolveOrgRole(user, "b")).toBeNull();
    expect(visibleOrgs(user, orgs, { production: false }).map((o) => o.slug)).toEqual(["api-pharma"]);
  });
  it("owners are admins everywhere", () => {
    const owner = { isOwner: true, memberships: [] };
    expect(resolveOrgRole(owner, "b")).toBe("admin");
    expect(visibleOrgs(owner, orgs, { production: false }).map((o) => o.slug)).toEqual(["api-pharma", "pioneer-biotech", "demo-pharma"]);
  });
  it("demo companies are hidden in production", () => {
    const owner = { isOwner: true, memberships: [] };
    expect(visibleOrgs(owner, orgs, { production: true }).map((o) => o.slug)).toEqual(["api-pharma", "pioneer-biotech"]);
  });
  it("company switcher picks URL, then cookie, then first", () => {
    const user = { isOwner: false, memberships: [{ orgId: "a", role: "viewer" as const }, { orgId: "b", role: "admin" as const }] };
    const vis = visibleOrgs(user, orgs, { production: true });
    expect(pickOrg(vis, "pioneer-biotech", "api-pharma")?.slug).toBe("pioneer-biotech");
    expect(pickOrg(vis, "demo-pharma", "pioneer-biotech")?.slug).toBe("pioneer-biotech"); // URL not allowed → cookie
    expect(pickOrg(vis, null, "nope")?.slug).toBe("api-pharma");
    expect(pickOrg([], "x", "y")).toBeNull();
  });
  it("slugs", () => {
    expect(slugify("Pioneer Biotech")).toBe("pioneer-biotech");
    expect(slugify("  API Pharma!! ")).toBe("api-pharma");
    expect(isValidSlug("api-pharma")).toBe(true);
    expect(isValidSlug("-bad")).toBe(false);
    expect(isValidSlug("Bad Slug")).toBe(false);
  });
});
