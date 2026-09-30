import type { Role } from "./permissions.js";

export interface MembershipLike {
  orgId: string;
  role: Role;
}

export interface UserLike {
  isOwner: boolean;
  memberships: MembershipLike[];
}

/** Role of a user in a company: owners are admins everywhere; otherwise the membership role; null = no access. */
export function resolveOrgRole(user: UserLike, orgId: string): Role | null {
  if (user.isOwner) return "admin";
  return user.memberships.find((m) => m.orgId === orgId)?.role ?? null;
}

export interface OrgLike {
  id: string;
  slug: string;
  isDemo: boolean;
}

/** Companies a user may open, in the given order; demo companies are hidden in production. */
export function visibleOrgs<T extends OrgLike>(user: UserLike, orgs: T[], opts: { production: boolean }): T[] {
  return orgs.filter((o) => (!opts.production || !o.isDemo) && resolveOrgRole(user, o.id) != null);
}

/** Picks the company to open: the URL slug if allowed, else the remembered one, else the first visible. */
export function pickOrg<T extends OrgLike>(visible: T[], preferredSlug: string | null | undefined, rememberedSlug: string | null | undefined): T | null {
  return visible.find((o) => o.slug === preferredSlug) ?? visible.find((o) => o.slug === rememberedSlug) ?? visible[0] ?? null;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
export function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "company";
}
