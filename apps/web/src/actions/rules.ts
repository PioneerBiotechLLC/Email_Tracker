"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  EXCLUSION_ACTIONS, RULE_TYPES, assertSameOrg, countRuleMatches, domainOf, getDb, logAudit, normalizeRuleValue, orgDomains, orgSettings, reapplyExclusions, ruleValueError,
  type Prisma, type PrismaClient, type ReapplyResult, type SessionContext,
} from "@email-tracker/core";
import { requireOrgAction } from "@/lib/session";
import type { ActionResult } from "./settings";

/** Time budget for re-applying rules inside one request; what is left is finished by the next change or `pnpm rules:reapply`. */
const REAPPLY_SECONDS = 40;

const draftSchema = z.object({
  type: z.enum(RULE_TYPES),
  value: z.string(),
  andSubjectContains: z.string().trim().max(200).transform((v) => v || null),
  action: z.enum(EXCLUSION_ACTIONS),
  mailboxId: z.string().transform((v) => v || null),
  note: z.string().trim().max(300).transform((v) => v || null),
});

type RuleInput = z.infer<typeof draftSchema>;

/** Parses and validates a rule form against the company: value shape, mailbox ownership, and never the company's own domain. */
async function readRule(db: PrismaClient, ctx: SessionContext, formData: FormData): Promise<{ rule: RuleInput } | { error: string }> {
  const parsed = draftSchema.safeParse({
    type: formData.get("type"),
    value: String(formData.get("value") ?? ""),
    andSubjectContains: String(formData.get("andSubjectContains") ?? ""),
    action: formData.get("action") ?? "ignore",
    mailboxId: String(formData.get("mailboxId") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const rule = { ...parsed.data, value: normalizeRuleValue(parsed.data.type, parsed.data.value) };
  const invalid = ruleValueError(rule.type, rule.value);
  if (invalid) return { error: invalid };
  if (rule.mailboxId) assertSameOrg(ctx, await db.mailbox.findUnique({ where: { id: rule.mailboxId }, select: { orgId: true } }));
  if (rule.type === "sender_email" || rule.type === "sender_domain") {
    const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { domain: true, domains: true } });
    const domain = rule.type === "sender_domain" ? rule.value : domainOf(rule.value);
    if (orgDomains(org).has(domain)) return { error: `${domain} is this company's own domain; excluding it would hide your colleagues' mail.` };
  }
  return { rule };
}

const snapshot = (r: { type: string; value: string; andSubjectContains: string | null; action: string; mailboxId: string | null; note: string | null; isActive: boolean }) => ({
  type: r.type, value: r.value, andSubjectContains: r.andSubjectContains, action: r.action, mailboxId: r.mailboxId, note: r.note, isActive: r.isActive,
});

async function reapply(db: PrismaClient, orgId: string): Promise<ReapplyResult> {
  const r = await reapplyExclusions(db, orgId, { deadlineAt: new Date(Date.now() + REAPPLY_SECONDS * 1000) });
  revalidatePath("/c/[slug]", "layout");
  return r;
}

const affected = (r: ReapplyResult) =>
  `${r.changed} email${r.changed === 1 ? "" : "s"} affected${r.partial ? " so far; the rest is applied by the next sync or `pnpm rules:reapply`" : ""}`;

/** Live preview while typing a rule: how many emails of the last 90 days it matches. Nothing is saved. */
export async function previewExclusionRule(orgId: string, formData: FormData): Promise<{ count: number } | { error: string }> {
  const ctx = await requireOrgAction(orgId, "rules.manage");
  const db = getDb();
  const read = await readRule(db, ctx, formData);
  if ("error" in read) return read;
  return { count: await countRuleMatches(db, ctx.orgId, read.rule) };
}

/** Creates a rule (ruleId = null) or edits one, then re-applies the rules to the company's stored mail. */
export async function saveExclusionRule(orgId: string, ruleId: string | null, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "rules.manage");
  const db = getDb();
  const read = await readRule(db, ctx, formData);
  if ("error" in read) return { ok: false, message: read.error };
  const before = ruleId ? await db.exclusionRule.findUnique({ where: { id: ruleId } }) : null;
  if (ruleId) assertSameOrg(ctx, before);
  const saved = ruleId
    ? await db.exclusionRule.update({ where: { id: ruleId }, data: read.rule })
    : await db.exclusionRule.create({ data: { ...read.rule, orgId: ctx.orgId, createdBy: ctx.email } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: ruleId ? "rule.update" : "rule.create", targetType: "exclusion_rule", targetId: saved.id, before: before ? snapshot(before) : undefined, after: snapshot(saved) });
  return { ok: true, message: `Rule saved: ${affected(await reapply(db, ctx.orgId))}.` };
}

/** Deactivates or re-activates a rule (rules are never deleted, so the audit trail stays complete). */
export async function setRuleActive(orgId: string, ruleId: string, isActive: boolean) {
  const ctx = await requireOrgAction(orgId, "rules.manage");
  const db = getDb();
  const before = await db.exclusionRule.findUnique({ where: { id: ruleId } });
  assertSameOrg(ctx, before);
  await db.exclusionRule.update({ where: { id: ruleId }, data: { isActive } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: isActive ? "rule.activate" : "rule.deactivate", targetType: "exclusion_rule", targetId: ruleId, before: { isActive: before!.isActive }, after: { isActive } });
  await reapply(db, ctx.orgId);
}

export async function updateExclusionSettings(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "rules.manage");
  const db = getDb();
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { settings: true } });
  const before = orgSettings(org.settings);
  const after = { autoExclude: formData.get("autoExclude") === "on", outlookOtherNoReply: formData.get("outlookOtherNoReply") === "on", internalNoReply: formData.get("internalNoReply") === "on", ccNoReply: formData.get("ccNoReply") === "on" };
  const settings = { ...(org.settings && typeof org.settings === "object" && !Array.isArray(org.settings) ? org.settings : {}), ...after } as Prisma.InputJsonObject;
  await db.organization.update({ where: { id: ctx.orgId }, data: { settings } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.exclusions", targetType: "organization", targetId: ctx.orgId, before, after });
  return { ok: true, message: `Saved: ${affected(await reapply(db, ctx.orgId))}.` };
}

/** Where a quick action returns to: the tracker or a thread page of this company, never an arbitrary URL. */
function safeReturn(slug: string, returnTo: string, params: Record<string, string>): string {
  const [path = "", query = ""] = returnTo.split("?");
  const ok = path === `/c/${slug}/tracker` || new RegExp(`^/c/${slug}/threads/[a-z0-9]+$`).test(path);
  const q = new URLSearchParams(ok ? query : "");
  q.delete("rule");
  q.delete("affected");
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  const qs = q.toString();
  return `${ok ? path : `/c/${slug}/tracker`}${qs ? `?${qs}` : ""}`;
}

/**
 * "Ignore this sender" / "Ignore this domain" on an email: creates (or re-activates) an ignore rule
 * from the message's own sender, re-applies the rules and returns with the count and an Undo link.
 */
export async function ignoreSender(orgId: string, messageId: string, type: "sender_email" | "sender_domain", returnTo: string) {
  const ctx = await requireOrgAction(orgId, "rules.manage");
  const db = getDb();
  const message = await db.message.findUnique({ where: { id: messageId }, select: { fromAddress: true, mailbox: { select: { orgId: true } } } });
  assertSameOrg(ctx, message?.mailbox);
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { slug: true, domain: true, domains: true } });
  const from = message!.fromAddress.toLowerCase();
  const value = type === "sender_domain" ? domainOf(from) : from;
  if (ruleValueError(type, value) || orgDomains(org).has(domainOf(from))) redirect(safeReturn(org.slug, returnTo, { rule: "invalid" }));

  const existing = await db.exclusionRule.findFirst({ where: { orgId: ctx.orgId, type, value, mailboxId: null, andSubjectContains: null } });
  const rule = existing
    ? await db.exclusionRule.update({ where: { id: existing.id }, data: { isActive: true, action: "ignore" } })
    : await db.exclusionRule.create({ data: { orgId: ctx.orgId, type, value, action: "ignore", note: "Added from an email (quick action)", createdBy: ctx.email } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: existing ? "rule.update" : "rule.create", targetType: "exclusion_rule", targetId: rule.id, before: existing ? snapshot(existing) : undefined, after: snapshot(rule) });
  const r = await reapply(db, ctx.orgId);
  redirect(safeReturn(org.slug, returnTo, { rule: rule.id, affected: String(r.changed) }));
}

/** Undo for the quick action: deactivates the rule and puts the emails back. */
export async function undoRule(orgId: string, ruleId: string, returnTo: string) {
  await setRuleActive(orgId, ruleId, false);
  const org = await getDb().organization.findUniqueOrThrow({ where: { id: orgId }, select: { slug: true } });
  redirect(safeReturn(org.slug, returnTo, {}));
}
