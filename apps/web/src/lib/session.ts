import "server-only";
import { redirect } from "next/navigation";
import { assertCan, getDb, type Action, type SessionContext } from "@email-tracker/core";
import { auth } from "@/auth";
import { e2eBypassEmail } from "@/lib/e2e";

export interface WebSession extends SessionContext {
  name: string | null;
}

/**
 * The signed-in user's org and role, from the JWT. Under NODE_ENV=test with
 * E2E_BYPASS_EMAIL set, the named AppUser is used instead (Playwright only).
 */
export async function getSessionContext(): Promise<WebSession> {
  if (e2eBypassEmail) {
    const u = await getDb().appUser.findUnique({ where: { email: e2eBypassEmail } });
    if (u && u.isActive) return { userId: u.id, email: u.email, name: u.name, orgId: u.orgId, role: u.role };
  }
  const session = await auth();
  const u = session?.user;
  if (!u?.orgId || !u.email) redirect("/signin");
  return { userId: u.userId, email: u.email.toLowerCase(), name: u.name ?? null, orgId: u.orgId, role: u.role };
}

/** For server actions: returns the session or throws ForbiddenError when the role can't do the action. */
export async function requireAction(action: Action): Promise<WebSession> {
  const ctx = await getSessionContext();
  assertCan(ctx, action);
  return ctx;
}

/** For admin-only pages: redirects viewers to the overview. */
export async function requireAdminPage(): Promise<WebSession> {
  const ctx = await getSessionContext();
  if (ctx.role !== "admin") redirect("/?denied=1");
  return ctx;
}
