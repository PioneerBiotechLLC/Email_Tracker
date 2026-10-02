/**
 * DB side of the exclusion rules (pure matching lives in ./exclusions.ts):
 * loading a company's rules for a sync, re-applying them to the messages that
 * are already stored, the "matches N emails" preview and the default rules.
 */
import type { Prisma, PrismaClient } from "../db.js";
import { createLogger } from "../log.js";
import { orgSettings } from "../org-settings.js";
import { evaluateExclusion, matchesRule, orderRules, type ExclusionAction, type ExclusionSettings, type RuleLike, type RuleType } from "./exclusions.js";
import { recomputeThread } from "./threads.js";

const log = createLogger("exclusions");

export interface ExclusionContext {
  /** active rules of the company, most specific first */
  rules: RuleLike[];
  settings: ExclusionSettings;
}

/** A company's active rules and detection settings. Always scoped by orgId: one company's rules never see another's mail. */
export async function loadExclusionContext(db: PrismaClient, orgId: string): Promise<ExclusionContext> {
  const [org, rules] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } }),
    db.exclusionRule.findMany({ where: { orgId, isActive: true }, select: { id: true, mailboxId: true, type: true, value: true, andSubjectContains: true, action: true, createdAt: true } }),
  ]);
  return { rules: orderRules(rules), settings: orgSettings(org.settings) };
}

export interface ReapplyOptions {
  /** stop between chunks once this time passes; a later run continues where this one stopped */
  deadlineAt?: Date;
  onProgress?: (scanned: number, total: number) => void;
}

export interface ReapplyResult {
  scanned: number;
  /** messages whose exclusion changed */
  changed: number;
  threadsRecomputed: number;
  /** true when the deadline stopped the pass early */
  partial: boolean;
}

const CHUNK = 500;

/**
 * Re-evaluates every stored inbound message of a company against its current
 * rules (after a rule or setting change) and recomputes the affected threads.
 * Chunked and idempotent: each chunk writes its messages and recomputes its
 * threads before the next one starts, so an interrupted pass can simply be run again.
 */
export async function reapplyExclusions(db: PrismaClient, orgId: string, opts: ReapplyOptions = {}): Promise<ReapplyResult> {
  const { rules, settings } = await loadExclusionContext(db, orgId);
  const where = { mailbox: { orgId }, direction: "inbound" } satisfies Prisma.MessageWhereInput;
  const total = await db.message.count({ where });
  const out: ReapplyResult = { scanned: 0, changed: 0, threadsRecomputed: 0, partial: false };
  let cursor: string | undefined;
  for (;;) {
    if (opts.deadlineAt && Date.now() >= opts.deadlineAt.getTime()) {
      out.partial = true;
      break;
    }
    const page = await db.message.findMany({
      where,
      select: { id: true, mailboxId: true, conversationId: true, fromAddress: true, subject: true, autoSignals: true, inferenceClassification: true, excludedBy: true, exclusionAction: true },
      orderBy: { id: "asc" },
      take: CHUNK,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;

    // Rows that change, grouped by their new value so each group is one UPDATE.
    const groups = new Map<string, { excludedBy: string | null; exclusionAction: ExclusionAction | null; ids: string[] }>();
    const threads = new Map<string, { mailboxId: string; conversationId: string }>();
    for (const m of page) {
      const want = evaluateExclusion(m, rules, settings);
      if (want.excludedBy === m.excludedBy && want.exclusionAction === m.exclusionAction) continue;
      const key = `${want.excludedBy}\u0000${want.exclusionAction}`;
      (groups.get(key) ?? groups.set(key, { ...want, ids: [] }).get(key)!).ids.push(m.id);
      threads.set(`${m.mailboxId}\u0000${m.conversationId}`, { mailboxId: m.mailboxId, conversationId: m.conversationId });
    }
    for (const g of groups.values()) {
      await db.message.updateMany({ where: { id: { in: g.ids } }, data: { excludedBy: g.excludedBy, exclusionAction: g.exclusionAction } });
      out.changed += g.ids.length;
    }
    for (const t of threads.values()) {
      await recomputeThread(db, t.mailboxId, t.conversationId);
      out.threadsRecomputed += 1;
    }

    out.scanned += page.length;
    opts.onProgress?.(out.scanned, total);
    cursor = page[page.length - 1]!.id;
    if (page.length < CHUNK) break;
  }
  log.info("rules re-applied", { orgId, ...out });
  return out;
}

export interface RuleDraft {
  mailboxId: string | null;
  type: RuleType;
  value: string;
  andSubjectContains: string | null;
}

/** How many stored inbound emails of the last `days` days a rule (saved or not) matches. */
export async function countRuleMatches(db: PrismaClient, orgId: string, draft: RuleDraft, days = 90, now = new Date()): Promise<number> {
  const where = {
    mailbox: { orgId },
    ...(draft.mailboxId ? { mailboxId: draft.mailboxId } : {}),
    direction: "inbound",
    receivedAt: { gte: new Date(now.getTime() - days * 86_400_000) },
  } satisfies Prisma.MessageWhereInput;
  let n = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await db.message.findMany({ where, select: { id: true, mailboxId: true, fromAddress: true, subject: true }, orderBy: { id: "asc" }, take: 5000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    for (const m of page) if (matchesRule(draft, m)) n += 1;
    if (page.length < 5000) break;
    cursor = page[page.length - 1]!.id;
  }
  return n;
}

interface DefaultRule {
  defaultKey: string;
  type: RuleType;
  value: string;
  andSubjectContains?: string;
  action: ExclusionAction;
  note: string;
}

/** Seeded for every company; shown in Settings where they can be edited or deactivated. */
export const DEFAULT_EXCLUSION_RULES: readonly DefaultRule[] = [
  { defaultKey: "godaddy", type: "sender_domain", value: "godaddy.com", action: "ignore", note: "GoDaddy account/billing notifications" },
  { defaultKey: "secureserver", type: "sender_domain", value: "secureserver.net", action: "ignore", note: "GoDaddy hosting notifications" },
  { defaultKey: "microsoft-365", type: "sender_domain", value: "microsoft.com", andSubjectContains: "Microsoft 365", action: "no_reply_needed", note: "Microsoft 365 service messages" },
  { defaultKey: "mailer-daemon", type: "sender_email", value: "mailer-daemon@*", action: "ignore", note: "Delivery failure reports" },
  { defaultKey: "postmaster", type: "sender_email", value: "postmaster@*", action: "ignore", note: "Delivery failure reports" },
];

/**
 * Adds the default rules a company does not have yet. Idempotent: a default
 * that was edited or deactivated keeps its row (same defaultKey) and is left alone.
 * Returns the number of rules created.
 */
export async function seedDefaultRules(db: PrismaClient, orgId: string): Promise<number> {
  const r = await db.exclusionRule.createMany({
    data: DEFAULT_EXCLUSION_RULES.map((d) => ({ orgId, ...d, createdBy: "system" })),
    skipDuplicates: true,
  });
  return r.count;
}
