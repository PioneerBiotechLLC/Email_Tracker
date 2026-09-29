import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_HOURS } from "./business-hours.js";
import { computeThreadStatus, detectReplies, type ReplyInputMessage, type ReplyResult, type ThreadState } from "./replies.js";

const US = "sales@api-pharma.net";
const ALIAS = "orders@api-pharma.net";
const THEM = "ali@customer.com";
const owners = new Set([US, ALIAS]);
const opts = { owners, businessHours: DEFAULT_BUSINESS_HOURS };
const statusOpts = { ...opts, slaHours: 24 };
const dxb = (s: string) => new Date(`${s}+04:00`);

let seq = 0;
function inbound(p: Partial<ReplyInputMessage> & { receivedAt: Date }): ReplyInputMessage {
  const id = p.id ?? `in${++seq}`;
  return {
    id, direction: "inbound", fromAddress: THEM, toAddresses: [{ address: US }], ccAddresses: [],
    internetMessageId: `<${id}@customer.com>`, inReplyTo: null, references: [], sentAt: p.receivedAt,
    isAutoReply: false, lastVerb: null, lastVerbAt: null, ...p,
  };
}
function outbound(p: Partial<ReplyInputMessage> & { sentAt: Date }): ReplyInputMessage {
  const id = p.id ?? `out${++seq}`;
  return {
    id, direction: "outbound", fromAddress: US, toAddresses: [{ address: THEM }], ccAddresses: [],
    internetMessageId: `<${id}@api-pharma.net>`, inReplyTo: null, references: [], receivedAt: p.sentAt,
    isAutoReply: false, lastVerb: null, lastVerbAt: null, ...p,
  };
}
const byId = (rs: ReplyResult[], id: string) => rs.find((r) => r.messageId === id)!;
const fresh: ThreadState = { status: "awaiting_us", needsReply: true, closedAt: null };

describe("detectReplies", () => {
  it("reply via Outlook verb 102 (no sent copy)", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), lastVerb: 102, lastVerbAt: dxb("2026-09-28T11:30:00") });
    const r = byId(detectReplies([m], opts), "a");
    expect(r.repliedAt).toEqual(dxb("2026-09-28T11:30:00"));
    expect(r.replyMethod).toBe("outlook_verb");
    expect(r.repliedByMessageId).toBeNull();
    expect(r.responseMinutes).toBe(90);
    expect(r.responseBusinessMinutes).toBe(90);
  });

  it("reply-all verb 103 counts as a reply", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), lastVerb: 103, lastVerbAt: dxb("2026-09-28T10:10:00") });
    expect(byId(detectReplies([m], opts), "a").replyMethod).toBe("outlook_verb");
  });

  it("forward only (104) is NOT a reply", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), lastVerb: 104, lastVerbAt: dxb("2026-09-28T10:10:00") });
    const r = byId(detectReplies([m], opts), "a");
    expect(r.repliedAt).toBeNull();
    expect(r.replyMethod).toBeNull();
  });

  it("reply from a phone: no verb, header match (In-Reply-To)", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T13:00:00"), inReplyTo: "<a@customer.com>" });
    const r = byId(detectReplies([m, s], opts), "a");
    expect(r.replyMethod).toBe("header_match");
    expect(r.repliedByMessageId).toBe("s");
    expect(r.repliedAt).toEqual(dxb("2026-09-28T13:00:00"));
    expect(r.responseMinutes).toBe(180);
  });

  it("header match via References", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T13:00:00"), references: ["<root@x>", "<a@customer.com>"] });
    expect(byId(detectReplies([m, s], opts), "a").replyMethod).toBe("header_match");
  });

  it("no headers and no verb: conversation match to the sender", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), internetMessageId: null });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T14:00:00") });
    const r = byId(detectReplies([m, s], opts), "a");
    expect(r.replyMethod).toBe("conversation_match");
    expect(r.repliedByMessageId).toBe("s");
  });

  it("conversation match requires the sender in to/cc", () => {
    const m = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T14:00:00"), toAddresses: [{ address: "someone@else.com" }] });
    expect(byId(detectReplies([m, s], opts), "a").repliedAt).toBeNull();
    const cc = outbound({ id: "c", sentAt: dxb("2026-09-28T15:00:00"), toAddresses: [{ address: "x@y.com" }], ccAddresses: [{ address: THEM.toUpperCase() }] });
    expect(byId(detectReplies([m, cc], opts), "a").repliedByMessageId).toBe("c");
  });

  it("two inbound messages answered by one reply", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const b = inbound({ id: "b", receivedAt: dxb("2026-09-28T11:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T12:00:00"), inReplyTo: "<b@customer.com>" });
    const rs = detectReplies([a, b, s], opts);
    expect(byId(rs, "b").replyMethod).toBe("header_match");
    expect(byId(rs, "a").replyMethod).toBe("conversation_match");
    expect(byId(rs, "a").repliedByMessageId).toBe("s");
    expect(byId(rs, "a").responseMinutes).toBe(120);
  });

  it("later inbound after our reply stays unanswered", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T12:00:00") });
    const b = inbound({ id: "b", receivedAt: dxb("2026-09-28T13:00:00") });
    const rs = detectReplies([a, s, b], opts);
    expect(byId(rs, "a").repliedByMessageId).toBe("s");
    expect(byId(rs, "b").repliedAt).toBeNull();
  });

  it("thread whose subject changed mid-way still matches by conversation", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T12:00:00") }); // subject irrelevant to the logic
    expect(byId(detectReplies([a, s], opts), "a").repliedByMessageId).toBe("s");
  });

  it("out-of-office inbound is not an inbound needing reply", () => {
    const ooo = inbound({ id: "o", receivedAt: dxb("2026-09-28T10:00:00"), isAutoReply: true });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T12:00:00") });
    expect(byId(detectReplies([ooo, s], opts), "o").repliedAt).toBeNull();
  });

  it("our own out-of-office is not a reply", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const ooo = outbound({ id: "o", sentAt: dxb("2026-09-28T10:00:30"), isAutoReply: true, inReplyTo: "<a@customer.com>" });
    expect(byId(detectReplies([a, ooo], opts), "a").repliedAt).toBeNull();
  });

  it("message from an alias address is treated as ours (outbound)", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    // Landed in the inbox (direction inbound as synced) but sent from our alias.
    const fromAlias = inbound({ id: "x", receivedAt: dxb("2026-09-28T12:00:00"), fromAddress: ALIAS, toAddresses: [{ address: THEM }] });
    const rs = detectReplies([a, fromAlias], opts);
    expect(byId(rs, "x").repliedAt).toBeNull(); // not an inbound needing reply
    expect(byId(rs, "a").repliedByMessageId).toBe("x"); // and it answers the customer
  });

  it("verb time vs sent time mismatch: trust the verb, still link the sent message", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), lastVerb: 102, lastVerbAt: dxb("2026-09-28T10:20:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T10:25:00"), inReplyTo: "<a@customer.com>" });
    const r = byId(detectReplies([a, s], opts), "a");
    expect(r.repliedAt).toEqual(dxb("2026-09-28T10:20:00"));
    expect(r.replyMethod).toBe("outlook_verb");
    expect(r.repliedByMessageId).toBe("s");
    expect(r.responseMinutes).toBe(20);
  });

  it("never sets repliedAt earlier than receivedAt", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), lastVerb: 102, lastVerbAt: dxb("2026-09-28T09:00:00") });
    const early = outbound({ id: "e", sentAt: dxb("2026-09-28T09:30:00"), inReplyTo: "<a@customer.com>" });
    expect(byId(detectReplies([a, early], opts), "a").repliedAt).toBeNull();
  });

  it("uses sentAt for outbound messages when present", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T11:00:00"), receivedAt: dxb("2026-09-28T11:05:00") });
    expect(byId(detectReplies([a, s], opts), "a").repliedAt).toEqual(dxb("2026-09-28T11:00:00"));
  });

  it("business minutes: reply next morning after an evening email", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T20:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-29T09:30:00"), inReplyTo: "<a@customer.com>" });
    const r = byId(detectReplies([a, s], opts), "a");
    expect(r.responseMinutes).toBe(810);
    expect(r.responseBusinessMinutes).toBe(30);
  });
});

describe("computeThreadStatus", () => {
  it("awaiting_us when latest real message is unanswered inbound", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const rs = detectReplies([a], opts);
    const s = computeThreadStatus([a], rs, fresh, { ...statusOpts, now: dxb("2026-09-28T12:00:00") });
    expect(s.status).toBe("awaiting_us");
    expect(s.awaitingSince).toEqual(a.receivedAt);
    expect(s.isOverdue).toBe(false);
    expect(s.overdueAt).toEqual(dxb("2026-09-30T16:00:00")); // 24 business hours later
  });

  it("awaiting_them when we spoke last", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T12:00:00") });
    const st = computeThreadStatus([a, s], detectReplies([a, s], opts), fresh, statusOpts);
    expect(st.status).toBe("awaiting_them");
    expect(st.overdueAt).toBeNull();
  });

  it("awaiting_them when the latest inbound was answered via verb (sent copy not synced)", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00"), lastVerb: 102, lastVerbAt: dxb("2026-09-28T10:30:00") });
    expect(computeThreadStatus([a], detectReplies([a], opts), fresh, statusOpts).status).toBe("awaiting_them");
  });

  it("overdue after the SLA in business hours", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const rs = detectReplies([a], opts);
    expect(computeThreadStatus([a], rs, fresh, { ...statusOpts, now: dxb("2026-09-30T15:59:00") }).isOverdue).toBe(false);
    expect(computeThreadStatus([a], rs, fresh, { ...statusOpts, now: dxb("2026-09-30T16:00:00") }).isOverdue).toBe(true);
  });

  it("waits since the oldest unanswered inbound after our last message", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-27T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-27T11:00:00") });
    const b = inbound({ id: "b", receivedAt: dxb("2026-09-28T10:00:00") });
    const c = inbound({ id: "c", receivedAt: dxb("2026-09-29T10:00:00") });
    const st = computeThreadStatus([a, s, b, c], detectReplies([a, s, b, c], opts), fresh, statusOpts);
    expect(st.status).toBe("awaiting_us");
    expect(st.awaitingSince).toEqual(b.receivedAt);
  });

  it("ignores auto-replies when choosing the latest message", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const s = outbound({ id: "s", sentAt: dxb("2026-09-28T12:00:00") });
    const ooo = inbound({ id: "o", receivedAt: dxb("2026-09-28T12:00:30"), isAutoReply: true });
    expect(computeThreadStatus([a, s, ooo], detectReplies([a, s, ooo], opts), fresh, statusOpts).status).toBe("awaiting_them");
  });

  it("a thread with only auto-replies needs no reply", () => {
    const ooo = inbound({ id: "o", receivedAt: dxb("2026-09-28T12:00:30"), isAutoReply: true });
    expect(computeThreadStatus([ooo], detectReplies([ooo], opts), fresh, statusOpts).status).toBe("no_reply_needed");
  });

  it("manual close is kept when nothing new arrives", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const closed: ThreadState = { status: "closed", needsReply: true, closedAt: dxb("2026-09-28T11:00:00") };
    expect(computeThreadStatus([a], detectReplies([a], opts), closed, statusOpts).status).toBe("closed");
  });

  it("a new inbound after a manual close reopens the thread", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const b = inbound({ id: "b", receivedAt: dxb("2026-09-29T10:00:00") });
    const closed: ThreadState = { status: "closed", needsReply: true, closedAt: dxb("2026-09-28T11:00:00") };
    const st = computeThreadStatus([a, b], detectReplies([a, b], opts), closed, statusOpts);
    expect(st.status).toBe("awaiting_us");
    expect(st.awaitingSince).toEqual(b.receivedAt);
  });

  it("no_reply_needed is sticky while needsReply is false", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    const nrn: ThreadState = { status: "no_reply_needed", needsReply: false, closedAt: null };
    expect(computeThreadStatus([a], detectReplies([a], opts), nrn, statusOpts).status).toBe("no_reply_needed");
    // AI flips needsReply back on → recomputed normally
    expect(computeThreadStatus([a], detectReplies([a], opts), { ...nrn, needsReply: true }, statusOpts).status).toBe("awaiting_us");
  });

  it("needsReply=false on an unanswered inbound yields no_reply_needed", () => {
    const a = inbound({ id: "a", receivedAt: dxb("2026-09-28T10:00:00") });
    expect(computeThreadStatus([a], detectReplies([a], opts), { ...fresh, needsReply: false }, statusOpts).status).toBe("no_reply_needed");
  });
});
