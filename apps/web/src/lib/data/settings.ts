import "server-only";
import { getDb, getEnv, usageReport, type SessionContext } from "@email-tracker/core";

export async function getSettings(ctx: SessionContext) {
  const db = getDb();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000) + 1;
  const [org, mailboxes, users, usage] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId } }),
    db.mailbox.findMany({ where: { orgId: ctx.orgId }, orderBy: { emailAddress: "asc" }, include: { _count: { select: { threads: true, messages: true } } } }),
    db.membership.findMany({ where: { orgId: ctx.orgId }, include: { user: true }, orderBy: [{ user: { isActive: "desc" } }, { user: { email: "asc" } }] }),
    usageReport(days, ctx.orgId),
  ]);
  const env = getEnv();
  return { org, mailboxes, users, usage, ai: { cap: env.AI_MAX_CALLS_PER_DAY, model: env.ANTHROPIC_MODEL, light: env.ANTHROPIC_MODEL_LIGHT ?? null, keyConfigured: !!env.ANTHROPIC_API_KEY } };
}
