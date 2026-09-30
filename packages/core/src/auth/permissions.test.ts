import { describe, expect, it } from "vitest";
import { assertCan, assertSameOrg, can, ForbiddenError, mailboxScope } from "./permissions.js";

describe("permissions", () => {
  it("viewers cannot run any mutating action; admins can", () => {
    for (const a of ["thread.close", "thread.needsReply", "thread.resummarize", "thread.classify", "settings.edit", "users.manage", "mailbox.toggle"] as const) {
      expect(can("viewer", a)).toBe(false);
      expect(can("admin", a)).toBe(true);
      expect(() => assertCan({ role: "viewer" }, a)).toThrow(ForbiddenError);
      expect(() => assertCan({ role: "admin" }, a)).not.toThrow();
    }
  });
  it("blocks access to another organization's resources", () => {
    const ctx = { orgId: "org-a" };
    expect(() => assertSameOrg(ctx, { orgId: "org-a" })).not.toThrow();
    expect(() => assertSameOrg(ctx, { orgId: "org-b" })).toThrow(ForbiddenError);
    expect(() => assertSameOrg(ctx, null)).toThrow(ForbiddenError);
  });
  it("scopes queries to the org (primary copies only) unless a mailbox is chosen", () => {
    expect(mailboxScope({ orgId: "org-a" })).toEqual({ mailbox: { orgId: "org-a" }, duplicateOfId: null });
    expect(mailboxScope({ orgId: "org-a" }, "mb-1")).toEqual({ mailboxId: "mb-1" });
  });
  it("any member may generate a period summary", () => {
    expect(can("viewer", "summary.generate")).toBe(true);
    expect(can("admin", "summary.generate")).toBe(true);
  });
});
