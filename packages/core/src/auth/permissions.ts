/**
 * Dashboard authorization. Every server action and query passes through these
 * helpers so org scoping and roles are enforced in one place (unit-tested).
 */
export type Role = "admin" | "viewer";

export interface SessionContext {
  userId: string;
  email: string;
  orgId: string;
  role: Role;
}

export type Action =
  | "thread.close"
  | "thread.reopen"
  | "thread.needsReply"
  | "thread.resummarize"
  | "thread.classify"
  | "settings.edit"
  | "users.manage"
  | "mailbox.toggle";

const ADMIN_ONLY: ReadonlySet<Action> = new Set<Action>([
  "thread.close", "thread.reopen", "thread.needsReply", "thread.resummarize", "thread.classify", "settings.edit", "users.manage", "mailbox.toggle",
]);

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = "You do not have permission to do that") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export function can(role: Role, action: Action): boolean {
  if (role === "admin") return true;
  return !ADMIN_ONLY.has(action);
}

export function assertCan(ctx: Pick<SessionContext, "role">, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(`Role "${ctx.role}" cannot perform ${action}`);
}

/** Throws unless the resource belongs to the session's organization (multi-tenant guard). */
export function assertSameOrg(ctx: Pick<SessionContext, "orgId">, resource: { orgId: string } | null | undefined): void {
  if (!resource || resource.orgId !== ctx.orgId) throw new ForbiddenError("Not found in your organization");
}

/** Prisma `where` fragment that scopes mailbox-owned rows (threads, messages) to the org, optionally to one mailbox. */
export function mailboxScope(ctx: Pick<SessionContext, "orgId">, mailboxId?: string | null): { mailboxId: string } | { mailbox: { orgId: string } } {
  return mailboxId ? { mailboxId } : { mailbox: { orgId: ctx.orgId } };
}
