import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { assertCan, getDb, resolveOrgRole, visibleOrgs, ForbiddenError, type Action, type Role, type SessionContext } from "@email-tracker/core";
import { auth } from "@/auth";
import { e2eBypassEmail } from "@/lib/e2e";

export const COMPANY_COOKIE = "company";
export const isProduction = process.env.VERCEL_ENV === "production";

export interface UserSession {
  userId: string;
  email: string;
  name: string | null;
  isOwner: boolean;
  memberships: { orgId: string; role: Role }[];
}

/** The signed-in user with their memberships (memoized per request). Redirects to sign-in when absent. */
export const getSession = cache(async (): Promise<UserSession> => {
  const db = getDb();
  let email: string | null = null;
  if (e2eBypassEmail) email = e2eBypassEmail;
  else {
    const s = await auth();
    if (!s?.user?.userId || !s.user.email) redirect("/signin");
    email = s.user.email.toLowerCase();
  }
  const u = await db.appUser.findUnique({ where: { email }, include: { memberships: { select: { orgId: true, role: true } } } });
  if (!u || !u.isActive) redirect("/no-access");
  return { userId: u.id, email: u.email, name: u.name, isOwner: u.isOwner, memberships: u.memberships };
});

/** Companies this user may open (demo companies hidden in production). */
export const getVisibleCompanies = cache(async (session: UserSession) => {
  const orgs = await getDb().organization.findMany({ orderBy: { name: "asc" }, select: { id: true, slug: true, name: true, logoUrl: true, isDemo: true, primaryColor: true } });
  return visibleOrgs(session, orgs, { production: isProduction });
});

export interface CompanyContext {
  session: UserSession;
  org: NonNullable<Awaited<ReturnType<typeof loadOrg>>>;
  role: Role;
  /** Legacy shape used by queries/actions: org-scoped session context */
  ctx: SessionContext;
  mailboxes: { id: string; emailAddress: string; displayName: string | null; isActive: boolean; aliases: string[]; lastSyncedAt: Date | null; lastSyncError: string | null; lastSyncErrorAt: Date | null }[];
}

const loadOrg = cache(async (slug: string) => getDb().organization.findUnique({ where: { slug } }));

/**
 * Resolves /c/<slug>: the company must exist and the user must be an owner or a
 * member — otherwise 404 (the URL alone is never trusted).
 */
export const getCompanyContext = cache(async (slug: string): Promise<CompanyContext> => {
  const session = await getSession();
  const org = await loadOrg(slug);
  if (!org || (isProduction && org.isDemo)) notFound();
  const role = resolveOrgRole(session, org.id);
  if (!role) notFound();
  const mailboxes = await getDb().mailbox.findMany({ where: { orgId: org.id }, orderBy: { emailAddress: "asc" }, select: { id: true, emailAddress: true, displayName: true, isActive: true, aliases: true, lastSyncedAt: true, lastSyncError: true, lastSyncErrorAt: true } });
  return { session, org, role, ctx: { userId: session.userId, email: session.email, orgId: org.id, role }, mailboxes };
});

/** For admin-only pages: viewers are sent back to the company overview. */
export async function requireAdminPage(slug: string): Promise<CompanyContext> {
  const c = await getCompanyContext(slug);
  if (c.role !== "admin") redirect(`/c/${slug}?denied=1`);
  return c;
}

/** For server actions that know the org id: membership + role check, throws ForbiddenError. */
export async function requireOrgAction(orgId: string, action: Action): Promise<SessionContext> {
  const session = await getSession();
  const role = resolveOrgRole(session, orgId);
  if (!role) throw new ForbiddenError("Not found in your organization");
  const ctx: SessionContext = { userId: session.userId, email: session.email, orgId, role };
  assertCan(ctx, action);
  return ctx;
}

export async function requireOwner(): Promise<UserSession> {
  const session = await getSession();
  if (!session.isOwner) notFound();
  return session;
}

export async function rememberedCompanySlug(): Promise<string | null> {
  return (await cookies()).get(COMPANY_COOKIE)?.value ?? null;
}
