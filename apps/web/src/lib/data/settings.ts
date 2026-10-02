import "server-only";
import { exclusionReason, getDb, getEnv, orgSettings, usageReport, type SessionContext } from "@email-tracker/core";

export async function getSettings(ctx: SessionContext) {
  const db = getDb();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const days = Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000) + 1;
  const [org, mailboxes, users, usage, rules, excluded, chatQuestions] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: ctx.orgId } }),
    db.mailbox.findMany({ where: { orgId: ctx.orgId }, orderBy: { emailAddress: "asc" }, include: { _count: { select: { threads: true, messages: true } } } }),
    db.membership.findMany({ where: { orgId: ctx.orgId }, include: { user: true }, orderBy: [{ user: { isActive: "desc" } }, { user: { email: "asc" } }] }),
    usageReport(days, ctx.orgId),
    db.exclusionRule.findMany({ where: { orgId: ctx.orgId }, orderBy: [{ isActive: "desc" }, { createdAt: "asc" }], include: { mailbox: { select: { emailAddress: true } } } }),
    db.message.groupBy({ by: ["excludedBy"], where: { mailbox: { orgId: ctx.orgId }, excludedBy: { not: null } }, _count: { _all: true } }),
    db.chatTurn.count({ where: { session: { orgId: ctx.orgId }, createdAt: { gte: monthStart } } }),
  ]);
  const counts = new Map(excluded.map((e) => [e.excludedBy!, e._count._all]));
  const exclusions = {
    settings: orgSettings(org.settings),
    rules: rules.map((r) => ({ ...r, matches: counts.get(r.id) ?? 0 })),
    auto: excluded.filter((e) => e.excludedBy!.startsWith("auto:")).map((e) => ({ reason: exclusionReason(e.excludedBy), count: e._count._all })).sort((a, b) => b.count - a.count),
  };
  const env = getEnv();
  return { org, mailboxes, users, usage, exclusions, chatQuestions, searchIndexBodies: orgSettings(org.settings).searchIndexBodies, ai: { cap: env.AI_MAX_CALLS_PER_DAY, model: env.ANTHROPIC_MODEL, light: env.ANTHROPIC_MODEL_LIGHT ?? null, keyConfigured: !!env.ANTHROPIC_API_KEY } };
}
