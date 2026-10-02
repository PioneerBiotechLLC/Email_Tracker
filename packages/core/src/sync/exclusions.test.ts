import { describe, expect, it } from "vitest";
import { orgSettings } from "../org-settings.js";
import { businessMinutesBetween, DEFAULT_BUSINESS_HOURS } from "./business-hours.js";
import {
  autoSignal, evaluateExclusion, exclusionReason, headerSignals, isNoReplySender, listVisibility, matchesRule, normalizeRuleValue, orderRules, ruleValueError, threadExclusion,
  type ExclusionInput, type RuleLike,
} from "./exclusions.js";
import { computeThreadStatus, detectReplies, type ReplyInputMessage } from "./replies.js";

const ON = { autoExclude: true, outlookOtherNoReply: true };
const OFF = { autoExclude: false, outlookOtherNoReply: false };

function msg(p: Partial<ExclusionInput> = {}): ExclusionInput {
  return { mailboxId: "mb-sales", fromAddress: "ali@customer.com", subject: "PO 4512", autoSignals: [], inferenceClassification: "focused", ...p };
}
let seq = 0;
function rule(p: Partial<RuleLike> & Pick<RuleLike, "type" | "value">): RuleLike {
  seq += 1;
  return { id: `r${seq}`, mailboxId: null, andSubjectContains: null, action: "ignore", createdAt: new Date(2026, 0, seq), ...p };
}

describe("rule types", () => {
  it("sender_email matches the exact address, case-insensitively", () => {
    const r = rule({ type: "sender_email", value: "billing@godaddy.com" });
    expect(matchesRule(r, msg({ fromAddress: "Billing@GoDaddy.com" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "support@godaddy.com" }))).toBe(false);
  });
  it("sender_email with @* matches that mailbox name at any domain", () => {
    const r = rule({ type: "sender_email", value: "mailer-daemon@*" });
    expect(matchesRule(r, msg({ fromAddress: "MAILER-DAEMON@mx.google.com" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "mailer-daemon2@mx.google.com" }))).toBe(false);
    expect(matchesRule(r, msg({ fromAddress: "" }))).toBe(false);
  });
  it("sender_domain matches the domain and its subdomains, but not look-alikes", () => {
    const r = rule({ type: "sender_domain", value: "godaddy.com" });
    expect(matchesRule(r, msg({ fromAddress: "x@godaddy.com" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "x@email.GoDaddy.com" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "x@a.b.godaddy.com" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "x@notgodaddy.com" }))).toBe(false);
    expect(matchesRule(r, msg({ fromAddress: "x@godaddy.com.evil.net" }))).toBe(false);
  });
  it("subject_contains is a case-insensitive substring (Arabic too)", () => {
    expect(matchesRule(rule({ type: "subject_contains", value: "Account Activity" }), msg({ subject: "Your account activity for September" }))).toBe(true);
    expect(matchesRule(rule({ type: "subject_contains", value: "نشرة" }), msg({ subject: "نشرة الأسعار الأسبوعية" }))).toBe(true);
    expect(matchesRule(rule({ type: "subject_contains", value: "invoice" }), msg({ subject: "PO 4512" }))).toBe(false);
  });
  it("subject_regex is case-insensitive; an invalid pattern never matches", () => {
    expect(matchesRule(rule({ type: "subject_regex", value: "^\\[alert\\]\\s+\\d+" }), msg({ subject: "[ALERT] 42 disk usage" }))).toBe(true);
    expect(matchesRule(rule({ type: "subject_regex", value: "^\\[alert\\]" }), msg({ subject: "RE: [alert]" }))).toBe(false);
    expect(matchesRule(rule({ type: "subject_regex", value: "([" }), msg({ subject: "([" }))).toBe(false);
  });
  it("two conditions are ANDed: sender domain + subject contains", () => {
    const r = rule({ type: "sender_domain", value: "microsoft.com", andSubjectContains: "Microsoft 365", action: "no_reply_needed" });
    expect(matchesRule(r, msg({ fromAddress: "billing@microsoft.com", subject: "Your microsoft 365 invoice is ready" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "billing@microsoft.com", subject: "Azure invoice" }))).toBe(false);
    expect(matchesRule(r, msg({ fromAddress: "ali@customer.com", subject: "Microsoft 365 licences quote" }))).toBe(false);
  });
  it("a mailbox rule only applies to that mailbox", () => {
    const r = rule({ type: "sender_domain", value: "vendor.com", mailboxId: "mb-regulatory" });
    expect(matchesRule(r, msg({ fromAddress: "a@vendor.com", mailboxId: "mb-regulatory" }))).toBe(true);
    expect(matchesRule(r, msg({ fromAddress: "a@vendor.com", mailboxId: "mb-sales" }))).toBe(false);
  });
});

describe("rule values", () => {
  it("normalizes addresses and domains", () => {
    expect(normalizeRuleValue("sender_domain", " @GoDaddy.com ")).toBe("godaddy.com");
    expect(normalizeRuleValue("sender_domain", "*.godaddy.com")).toBe("godaddy.com");
    expect(normalizeRuleValue("sender_email", " Billing@GoDaddy.com")).toBe("billing@godaddy.com");
    expect(normalizeRuleValue("subject_regex", " ^Alert ")).toBe("^Alert");
  });
  it("rejects malformed values", () => {
    expect(ruleValueError("sender_domain", "godaddy.com")).toBeNull();
    expect(ruleValueError("sender_domain", "godaddy")).toMatch(/domain/);
    expect(ruleValueError("sender_email", "postmaster@*")).toBeNull();
    expect(ruleValueError("sender_email", "not-an-address")).toMatch(/address/);
    expect(ruleValueError("subject_regex", "([")).toMatch(/regular expression/);
    expect(ruleValueError("subject_contains", "")).toMatch(/Enter/);
    expect(ruleValueError("subject_contains", "x".repeat(201))).toMatch(/200/);
  });
});

describe("built-in detection", () => {
  it("reads bulk-mail headers", () => {
    expect(headerSignals([{ name: "List-Unsubscribe", value: "<mailto:u@x.com>" }, { name: "List-Id", value: "<news.x.com>" }])).toEqual(["list-unsubscribe", "list-id"]);
    expect(headerSignals([{ name: "Precedence", value: "Bulk" }])).toEqual(["precedence-bulk"]);
    expect(headerSignals([{ name: "precedence", value: "list" }, { name: "X-Auto-Response-Suppress", value: "All" }])).toEqual(["precedence-bulk", "auto-response-suppress"]);
    expect(headerSignals([{ name: "Precedence", value: "first-class" }, { name: "Subject", value: "hi" }])).toEqual([]);
    expect(headerSignals(null)).toEqual([]);
  });
  it("recognizes no-reply style senders", () => {
    for (const a of ["noreply@x.com", "No-Reply@x.com", "no_reply@x.com", "donotreply@x.com", "do-not-reply@x.com", "notifications@github.com", "notification@x.com", "mailer-daemon@x.com", "postmaster@x.com", "noreply-billing@x.com", "notifications+abc@x.com"]) {
      expect(isNoReplySender(a), a).toBe(true);
    }
    for (const a of ["ali@customer.com", "norman@x.com", "reply@x.com", "postmasters@x.com", "sales@noreply.com", "nobody"]) {
      expect(isNoReplySender(a), a).toBe(false);
    }
  });
  it("marks detected mail no_reply_needed (never ignore) and stores why", () => {
    expect(evaluateExclusion(msg({ autoSignals: ["list-unsubscribe", "list-id"] }), [], ON)).toEqual({ excludedBy: "auto:list-unsubscribe", exclusionAction: "no_reply_needed" });
    expect(evaluateExclusion(msg({ fromAddress: "noreply@portal.com" }), [], ON)).toEqual({ excludedBy: "auto:noreply", exclusionAction: "no_reply_needed" });
    expect(evaluateExclusion(msg(), [], ON)).toEqual({ excludedBy: null, exclusionAction: null });
  });
  it("Outlook 'Other' is its own setting", () => {
    const other = msg({ inferenceClassification: "Other" });
    expect(autoSignal(other, ON)).toBe("auto:focused-other");
    expect(autoSignal(other, { autoExclude: true, outlookOtherNoReply: false })).toBeNull();
    expect(autoSignal(other, { autoExclude: false, outlookOtherNoReply: true })).toBe("auto:focused-other");
    expect(autoSignal(msg({ inferenceClassification: "focused" }), ON)).toBeNull();
    expect(autoSignal(msg({ inferenceClassification: null }), ON)).toBeNull();
  });
  it("can be turned off per company; settings default to on", () => {
    expect(evaluateExclusion(msg({ autoSignals: ["list-id"], fromAddress: "noreply@x.com", inferenceClassification: "other" }), [], OFF)).toEqual({ excludedBy: null, exclusionAction: null });
    expect(orgSettings({})).toEqual(ON);
    expect(orgSettings(null)).toEqual(ON);
    expect(orgSettings({ autoExclude: false, outlookOtherNoReply: "yes" })).toEqual({ autoExclude: false, outlookOtherNoReply: true });
  });
});

describe("evaluateExclusion", () => {
  it("a company rule wins over auto-detection", () => {
    const r = rule({ type: "sender_domain", value: "godaddy.com", action: "ignore" });
    expect(evaluateExclusion(msg({ fromAddress: "noreply@godaddy.com", autoSignals: ["list-unsubscribe"] }), [r], ON)).toEqual({ excludedBy: r.id, exclusionAction: "ignore" });
  });
  it("orders rules: mailbox-specific, then ignore, then the oldest", () => {
    const org = rule({ type: "sender_domain", value: "vendor.com", action: "ignore" });
    const soft = rule({ type: "sender_domain", value: "vendor.com", action: "no_reply_needed" });
    const mailbox = rule({ type: "sender_domain", value: "vendor.com", action: "no_reply_needed", mailboxId: "mb-sales" });
    const ordered = orderRules([soft, org, mailbox]);
    expect(ordered.map((r) => r.id)).toEqual([mailbox.id, org.id, soft.id]);
    expect(evaluateExclusion(msg({ fromAddress: "a@vendor.com" }), ordered, OFF).excludedBy).toBe(mailbox.id);
    expect(evaluateExclusion(msg({ fromAddress: "a@vendor.com", mailboxId: "mb-other" }), ordered, OFF)).toEqual({ excludedBy: org.id, exclusionAction: "ignore" });
  });
  it("re-evaluating after a rule change gives the new answer (what re-apply does per message)", () => {
    const m = msg({ fromAddress: "billing@godaddy.com" });
    const r = rule({ type: "sender_domain", value: "godaddy.com" });
    expect(evaluateExclusion(m, [], ON).exclusionAction).toBeNull();
    expect(evaluateExclusion(m, [r], ON).exclusionAction).toBe("ignore");
    expect(evaluateExclusion(m, [{ ...r, action: "no_reply_needed" }], ON).exclusionAction).toBe("no_reply_needed");
    expect(evaluateExclusion(m, [], ON).exclusionAction).toBeNull();
  });
  it("describes the reason for the badge", () => {
    expect(exclusionReason("auto:noreply")).toBe("auto: no-reply sender");
    expect(exclusionReason("r1", { type: "sender_domain", value: "microsoft.com", andSubjectContains: "Microsoft 365" })).toBe('rule: domain microsoft.com + subject contains "Microsoft 365"');
    expect(exclusionReason("r-deleted", null)).toBe("rule");
    expect(exclusionReason(null)).toBe("");
  });
});

describe("threads with excluded mail", () => {
  it("a thread is excluded only when all its inbound mail is; ignore only when all are ignored", () => {
    expect(threadExclusion(["ignore", "ignore"])).toBe("ignore");
    expect(threadExclusion(["ignore", "no_reply_needed"])).toBe("no_reply_needed");
    expect(threadExclusion(["ignore", null])).toBeNull();
    expect(threadExclusion([])).toBeNull();
  });

  const owners = new Set(["sales@api-pharma.net"]);
  const opts = { owners, businessHours: DEFAULT_BUSINESS_HOURS, slaHours: 24, now: new Date("2026-09-10T08:00:00Z") };
  const fresh = { status: "awaiting_us" as const, needsReply: true, closedAt: null };
  // recomputeThread feeds excluded inbound mail to the status logic as automatic messages.
  const inbound = (id: string, at: string, excluded: boolean): ReplyInputMessage => ({
    id, direction: "inbound", fromAddress: excluded ? "noreply@portal.com" : "omar@customer.com", toAddresses: [{ address: "sales@api-pharma.net" }], ccAddresses: [],
    internetMessageId: `<${id}@x>`, inReplyTo: null, references: [], receivedAt: new Date(at), sentAt: null, isAutoReply: excluded, lastVerb: null, lastVerbAt: null,
  });

  it("only excluded mail → nobody is waiting", () => {
    const ms = [inbound("n1", "2026-09-01T08:00:00Z", true)];
    const s = computeThreadStatus(ms, detectReplies(ms, opts), fresh, opts);
    expect(s.status).toBe("no_reply_needed");
    expect(s.overdueAt).toBeNull();
  });
  it("a real person replying later in an excluded thread still counts, from their message on", () => {
    const ms = [inbound("n1", "2026-09-01T08:00:00Z", true), inbound("p1", "2026-09-02T08:00:00Z", false), inbound("n2", "2026-09-03T08:00:00Z", true)];
    const s = computeThreadStatus(ms, detectReplies(ms, opts), fresh, opts);
    expect(s.status).toBe("awaiting_us");
    expect(s.awaitingSince?.toISOString()).toBe("2026-09-02T08:00:00.000Z");
    expect(s.isOverdue).toBe(true);
    expect(businessMinutesBetween(s.awaitingSince!, s.overdueAt!, DEFAULT_BUSINESS_HOURS)).toBe(24 * 60);
  });
  it("excluded mail gets no reply fields, so reply KPIs never include it", () => {
    const ours: ReplyInputMessage = { ...inbound("s1", "2026-09-01T09:00:00Z", false), direction: "outbound", fromAddress: "sales@api-pharma.net", toAddresses: [{ address: "noreply@portal.com" }], sentAt: new Date("2026-09-01T09:00:00Z") };
    const r = detectReplies([inbound("n1", "2026-09-01T08:00:00Z", true), ours], opts);
    expect(r[0]!.repliedAt).toBeNull();
  });
});

describe("list visibility", () => {
  it("hides ignored mail unless 'Show excluded' is on; no_reply_needed mail is always listed", () => {
    expect(listVisibility(false)).toEqual({ OR: [{ exclusionAction: null }, { exclusionAction: "no_reply_needed" }] });
    expect(listVisibility(true)).toEqual({});
  });
});
