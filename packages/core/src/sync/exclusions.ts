/**
 * Exclusion rules: emails that should not be counted (account notifications,
 * newsletters, system alerts). Two actions:
 *  - "ignore": stored, but hidden everywhere by default and never sent to the AI;
 *  - "no_reply_needed": shown, but never awaiting a reply / overdue, and never sent to the AI.
 *
 * A message is excluded by the first matching company rule, else by the
 * built-in detection of internal, bulk and automatic mail and of Cc copies
 * (always "no_reply_needed", so nothing is hidden silently). Rules apply per
 * inbound message, never per thread: a real person replying later inside a
 * notification thread still counts.
 *
 * Pure functions only (unit-tested); the DB side lives in ./exclusion-rules.ts.
 */
import type { RawHeader } from "../mail/headers.js";
import { headerMap } from "../mail/headers.js";

export const RULE_TYPES = ["sender_email", "sender_domain", "subject_contains", "subject_regex"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export const EXCLUSION_ACTIONS = ["ignore", "no_reply_needed"] as const;
export type ExclusionAction = (typeof EXCLUSION_ACTIONS)[number];

export interface RuleLike {
  id: string;
  /** null = every mailbox of the company */
  mailboxId: string | null;
  type: RuleType;
  value: string;
  /** second condition, ANDed: the subject must also contain this text */
  andSubjectContains: string | null;
  action: ExclusionAction;
  createdAt: Date;
}

export interface ExclusionInput {
  mailboxId: string;
  fromAddress: string;
  subject: string;
  /** header signals recorded at sync time (see `headerSignals`) */
  autoSignals: readonly string[];
  /** Outlook Focused Inbox: "focused" | "other" */
  inferenceClassification: string | null;
  /** the message's To recipients (any object with an address) */
  toAddresses: readonly { address: string }[];
  /** the receiving mailbox's own addresses (address + aliases), lower-case */
  owners: ReadonlySet<string>;
}

export interface ExclusionSettings {
  autoExclude: boolean;
  outlookOtherNoReply: boolean;
  /** mail from the company's own domains (a colleague) needs no reply */
  internalNoReply?: boolean;
  /** the company's email domains, lower-case (needed for internalNoReply) */
  companyDomains?: ReadonlySet<string>;
  /** a copy in a mailbox that was only Cc'd (or not named) while another tracked mailbox is in To needs no reply there */
  ccNoReply?: boolean;
  /** lower-case addresses + aliases of every mailbox the company tracks (needed for ccNoReply) */
  trackedAddresses?: ReadonlySet<string>;
}

export interface Exclusion {
  /** rule id, or "auto:<signal>" */
  excludedBy: string | null;
  exclusionAction: ExclusionAction | null;
}

const NOT_EXCLUDED: Exclusion = { excludedBy: null, exclusionAction: null };
const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** Subjects are capped before regex matching so a slow pattern cannot stall a sync. */
const SUBJECT_MATCH_CHARS = 500;
const RULE_VALUE_MAX = 200;

/** Stored form of a rule value: trimmed; addresses and domains lower-cased, domains without "@" / "*." prefixes. */
export function normalizeRuleValue(type: RuleType, value: string): string {
  const v = value.trim();
  if (type === "sender_email") return v.toLowerCase();
  if (type === "sender_domain") return v.toLowerCase().replace(/^(\*\.|@|\.)+/, "");
  return v;
}

const regexCache = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    try { re = new RegExp(pattern, "i"); } catch { re = null; }
    regexCache.set(pattern, re);
  }
  return re;
}

/** Why a (normalized) rule value is not acceptable, or null when it is fine. */
export function ruleValueError(type: RuleType, value: string): string | null {
  if (!value) return "Enter a value";
  if (value.length > RULE_VALUE_MAX) return `Keep the value under ${RULE_VALUE_MAX} characters`;
  switch (type) {
    case "sender_email":
      return /^[^@\s]+@(\*|[a-z0-9.-]+\.[a-z]{2,})$/.test(value) ? null : "Enter an address like billing@godaddy.com, or name@* for any domain";
    case "sender_domain":
      return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value) ? null : "Enter a domain like godaddy.com";
    case "subject_regex":
      return compile(value) ? null : "Not a valid regular expression";
    case "subject_contains":
      return null;
  }
}

/** One rule against one message. Case-insensitive; a domain rule also matches its subdomains. */
export function matchesRule(rule: Pick<RuleLike, "mailboxId" | "type" | "value" | "andSubjectContains">, msg: Pick<ExclusionInput, "mailboxId" | "fromAddress" | "subject">): boolean {
  if (rule.mailboxId && rule.mailboxId !== msg.mailboxId) return false;
  const from = lower(msg.fromAddress);
  const at = from.lastIndexOf("@");
  const subject = msg.subject ?? "";
  const value = rule.type === "subject_regex" ? rule.value : lower(rule.value);
  let hit: boolean;
  switch (rule.type) {
    case "sender_email":
      hit = value.endsWith("@*") ? from.slice(0, at + 1) === value.slice(0, -1) : from === value;
      break;
    case "sender_domain": {
      const domain = at > 0 ? from.slice(at + 1) : "";
      hit = !!domain && (domain === value || domain.endsWith(`.${value}`));
      break;
    }
    case "subject_contains":
      hit = subject.toLowerCase().includes(value);
      break;
    case "subject_regex":
      hit = compile(value)?.test(subject.slice(0, SUBJECT_MATCH_CHARS)) ?? false;
      break;
  }
  if (!hit) return false;
  return !rule.andSubjectContains || subject.toLowerCase().includes(lower(rule.andSubjectContains));
}

/** Most specific first: a mailbox's own rules, then "ignore" before "no_reply_needed", then the oldest rule. */
export function orderRules<T extends RuleLike>(rules: T[]): T[] {
  return [...rules].sort(
    (a, b) =>
      Number(!!b.mailboxId) - Number(!!a.mailboxId) ||
      Number(b.action === "ignore") - Number(a.action === "ignore") ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Bulk-mail markers found in a message's internet headers. Headers are not
 * stored, so these are recorded on the message at sync time and rules can be
 * re-applied later without Graph. (Auto-Submitted is handled as `isAutoReply`.)
 */
export function headerSignals(headers: RawHeader[] | null | undefined): string[] {
  const map = headerMap(headers);
  const out: string[] = [];
  if (map["list-unsubscribe"]?.length) out.push("list-unsubscribe");
  if (map["list-id"]?.length) out.push("list-id");
  if (["bulk", "list", "junk"].includes(lower(map["precedence"]?.[0]))) out.push("precedence-bulk");
  if (map["x-auto-response-suppress"]?.length) out.push("auto-response-suppress");
  return out;
}

const NOREPLY_LOCAL_RE = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer-daemon|postmaster)(?:[-+._].*)?$/;

/** noreply@, no-reply@, donotreply@, notifications@, mailer-daemon@, postmaster@ (also with a suffix: noreply-billing@). */
export function isNoReplySender(address: string): boolean {
  const a = lower(address);
  const at = a.lastIndexOf("@");
  return at > 0 && NOREPLY_LOCAL_RE.test(a.slice(0, at));
}

/** Whether the sender is a colleague: the address is in one of the company's own domains. */
export function isInternalSender(address: string, companyDomains: ReadonlySet<string> | undefined): boolean {
  const a = lower(address);
  const at = a.lastIndexOf("@");
  return at > 0 && !!companyDomains?.has(a.slice(at + 1));
}

/**
 * Whether the message is a Cc copy for its mailbox: none of the mailbox's own addresses is in To while
 * another tracked mailbox of the company is. Only To counts, so a mailbox that was Cc'd, Bcc'd or reached
 * through a group address holds a copy. When no tracked mailbox was in To (the email went to a customer,
 * an untracked colleague or a group) the copy is the only record of the email and is not a copy.
 */
export function isCcCopy(msg: Pick<ExclusionInput, "toAddresses" | "owners">, tracked: ReadonlySet<string> | undefined): boolean {
  if (!tracked?.size) return false;
  const to = (msg.toAddresses ?? []).map((r) => lower(r?.address)).filter(Boolean);
  return !to.some((a) => msg.owners.has(a)) && to.some((a) => tracked.has(a));
}

/** Built-in detection: the first signal that marks the message as internal, bulk, automatic or a Cc copy, as "auto:<signal>". */
export function autoSignal(msg: Pick<ExclusionInput, "fromAddress" | "autoSignals" | "inferenceClassification" | "toAddresses" | "owners">, settings: ExclusionSettings): string | null {
  if (settings.internalNoReply && isInternalSender(msg.fromAddress, settings.companyDomains)) return INTERNAL_SIGNAL;
  if (settings.autoExclude) {
    if (msg.autoSignals.length) return `auto:${msg.autoSignals[0]}`;
    if (isNoReplySender(msg.fromAddress)) return "auto:noreply";
  }
  // After bulk mail, so a newsletter's copy carries the same reason as its primary (and stays unreadable like it).
  if (settings.ccNoReply && isCcCopy(msg, settings.trackedAddresses)) return CC_SIGNAL;
  if (settings.outlookOtherNoReply && lower(msg.inferenceClassification) === "other") return "auto:focused-other";
  return null;
}

/** The exclusion of one inbound message: company rules first (pass them through `orderRules`), then built-in detection. */
export function evaluateExclusion(msg: ExclusionInput, orderedRules: RuleLike[], settings: ExclusionSettings): Exclusion {
  const rule = orderedRules.find((r) => matchesRule(r, msg));
  if (rule) return { excludedBy: rule.id, exclusionAction: rule.action };
  const auto = autoSignal(msg, settings);
  return auto ? { excludedBy: auto, exclusionAction: "no_reply_needed" } : NOT_EXCLUDED;
}

/**
 * Thread-level exclusion from its real inbound messages (auto-replies left out):
 * excluded only when ALL of them are; "ignore" only when all of them are ignored.
 */
export function threadExclusion(inbound: (ExclusionAction | null)[]): ExclusionAction | null {
  if (!inbound.length || inbound.some((a) => !a)) return null;
  return inbound.every((a) => a === "ignore") ? "ignore" : "no_reply_needed";
}

/** Prisma `where` fragment for reply statistics (KPIs, the tracker): only mail that is not excluded at all. */
export const COUNTED = { exclusionAction: null } as const;

/** Signal of mail sent by a colleague: excluded from reply tracking only. */
export const INTERNAL_SIGNAL = "auto:internal";

/**
 * Signal of a Cc copy: the email was addressed To another tracked mailbox, which records it; this mailbox
 * was only Cc'd (or not named at all), so the copy is excluded from reply tracking only.
 */
export const CC_SIGNAL = "auto:cc";

/** Excluded mail that is still real content (a colleague's email, a Cc copy): read by the AI and Ask, left out of reply tracking. */
export const READABLE_SIGNALS: readonly string[] = [INTERNAL_SIGNAL, CC_SIGNAL];

/**
 * Prisma `where` fragment for what the AI and Ask read: mail that is not excluded, plus colleagues'
 * mail and Cc copies (real content; it just needs no reply here). Use it inside `AND: [...]` next to other ORs.
 */
export const READABLE = { OR: [{ exclusionAction: null }, { excludedBy: { in: [...READABLE_SIGNALS] } }] };

/** Whether an excluded message is still read by the AI and Ask (see READABLE). */
export const isReadable = (m: { exclusionAction: string | null; excludedBy: string | null }) => !m.exclusionAction || READABLE_SIGNALS.includes(m.excludedBy ?? "");

/**
 * Category of a thread whose inbound mail is all excluded: "internal" between colleagues only; left as it is
 * (null) when it is Cc copies of a conversation tracked in another mailbox (which it inherits the summary and
 * category from), possibly with colleagues' mail; a notification otherwise.
 */
export function excludedThreadCategory(excludedBy: (string | null)[]): "internal" | "notification" | null {
  if (!excludedBy.length) return null;
  if (excludedBy.every((s) => s === INTERNAL_SIGNAL)) return "internal";
  if (excludedBy.every((s) => !!s && READABLE_SIGNALS.includes(s))) return null;
  return "notification";
}

/**
 * Prisma `where` fragment for list views of threads or messages: mail excluded
 * with "ignore" is hidden unless the viewer switched on "Show excluded".
 */
export function listVisibility(showExcluded: boolean): { OR: ({ exclusionAction: null } | { exclusionAction: "no_reply_needed" })[] } | Record<string, never> {
  return showExcluded ? {} : { OR: [{ exclusionAction: null }, { exclusionAction: "no_reply_needed" }] };
}

const AUTO_LABEL: Record<string, string> = {
  [INTERNAL_SIGNAL]: "internal email (sent by a colleague)",
  [CC_SIGNAL]: "Cc copy (addressed To another tracked mailbox)",
  "auto:list-unsubscribe": "mailing list (List-Unsubscribe header)",
  "auto:list-id": "mailing list (List-Id header)",
  "auto:precedence-bulk": "bulk mail (Precedence header)",
  "auto:auto-response-suppress": "automatic mail (X-Auto-Response-Suppress header)",
  "auto:noreply": "no-reply sender",
  "auto:focused-other": "Outlook filed it under \"Other\"",
};

/** Human-readable reason for the badge next to an excluded email. */
export function exclusionReason(excludedBy: string | null, rule?: Pick<RuleLike, "type" | "value" | "andSubjectContains"> | null): string {
  if (!excludedBy) return "";
  if (excludedBy.startsWith("auto:")) return `auto: ${AUTO_LABEL[excludedBy] ?? excludedBy.slice(5)}`;
  if (!rule) return "rule";
  const what = { sender_email: "sender", sender_domain: "domain", subject_contains: "subject contains", subject_regex: "subject matches" }[rule.type];
  return `rule: ${what} ${rule.value}${rule.andSubjectContains ? ` + subject contains "${rule.andSubjectContains}"` : ""}`;
}
