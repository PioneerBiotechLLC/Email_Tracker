/**
 * Reply detection and thread status (SPEC §6). Pure functions — no DB access —
 * so every rule is unit-testable. The DB wrapper lives in ./threads.ts.
 */
import { addBusinessMinutes, businessMinutesBetween, rawMinutesBetween, type BusinessHours } from "./business-hours.js";

export type Direction = "inbound" | "outbound";
export type ReplyMethod = "outlook_verb" | "header_match" | "conversation_match";
export type ThreadStatus = "awaiting_us" | "awaiting_them" | "no_reply_needed" | "closed";

export interface Recipient {
  address: string;
}

export interface ReplyInputMessage {
  id: string;
  direction: Direction;
  fromAddress: string;
  toAddresses: Recipient[];
  ccAddresses: Recipient[];
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** For outbound messages the sync stores sentAt here too; see effectiveTime(). */
  receivedAt: Date;
  sentAt: Date | null;
  isAutoReply: boolean;
  /** PidTagLastVerbExecuted: 102 reply, 103 reply-all, 104 forward */
  lastVerb: number | null;
  lastVerbAt: Date | null;
}

export interface ReplyResult {
  messageId: string;
  repliedAt: Date | null;
  repliedByMessageId: string | null;
  replyMethod: ReplyMethod | null;
  responseMinutes: number | null;
  responseBusinessMinutes: number | null;
}

export interface DetectOptions {
  /** Lower-cased addresses that count as "us" (mailbox address + aliases) */
  owners: Set<string>;
  businessHours: BusinessHours;
  /**
   * Outbound messages from OTHER tracked mailboxes of the same company that belong
   * to this conversation (or reference its Message-IDs). When a colleague answers an
   * email we were Cc'd on, that answer counts as the reply here too.
   */
  extraOutbound?: ReplyInputMessage[];
}

export const REPLY_VERBS = new Set([102, 103]);
export const FORWARD_VERB = 104;

/**
 * The instant a message "happened". Outbound messages use sentAt when present
 * (the sync engine also stores sentAt in receivedAt for outbound, but sentAt is
 * authoritative); inbound messages use receivedAt.
 */
export function effectiveTime(m: Pick<ReplyInputMessage, "direction" | "receivedAt" | "sentAt">): Date {
  return m.direction === "outbound" && m.sentAt ? m.sentAt : m.receivedAt;
}

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Sent by us: direction outbound, or from one of the mailbox's own addresses. */
export function isFromUs(m: Pick<ReplyInputMessage, "direction" | "fromAddress">, owners: Set<string>): boolean {
  return m.direction === "outbound" || owners.has(lower(m.fromAddress));
}

/** A real inbound message that can need a reply (not ours, not an auto-reply). */
export function isRealInbound(m: ReplyInputMessage, owners: Set<string>): boolean {
  return !m.isAutoReply && !isFromUs(m, owners);
}

/** A real reply candidate from our side (auto-replies such as our own OOO never count). */
export function isRealOutbound(m: ReplyInputMessage, owners: Set<string>): boolean {
  return !m.isAutoReply && isFromUs(m, owners);
}

function addressedTo(s: ReplyInputMessage, address: string): boolean {
  const a = lower(address);
  if (!a) return false;
  return [...s.toAddresses, ...s.ccAddresses].some((r) => lower(r.address) === a);
}

function byTime(a: ReplyInputMessage, b: ReplyInputMessage): number {
  return effectiveTime(a).getTime() - effectiveTime(b).getTime();
}

/** True when the outbound message's In-Reply-To / References point at the inbound message. */
function isHeaderLinked(m: ReplyInputMessage, s: ReplyInputMessage): boolean {
  const id = m.internetMessageId;
  if (!id) return false;
  return s.inReplyTo === id || s.references.includes(id);
}

/** Earliest outbound message whose headers reference the inbound message and that was sent after it. */
function headerMatch(m: ReplyInputMessage, outbound: ReplyInputMessage[]): ReplyInputMessage | null {
  const received = m.receivedAt.getTime();
  for (const s of outbound) {
    if (effectiveTime(s).getTime() < received) continue;
    if (isHeaderLinked(m, s)) return s;
  }
  return null;
}

/** Earliest outbound message sent after the inbound one, addressed (to/cc) to its sender. */
function conversationMatch(m: ReplyInputMessage, outbound: ReplyInputMessage[]): ReplyInputMessage | null {
  const received = m.receivedAt.getTime();
  for (const s of outbound) {
    if (effectiveTime(s).getTime() <= received) continue;
    if (addressedTo(s, m.fromAddress)) return s;
  }
  return null;
}

function emptyResult(id: string): ReplyResult {
  return { messageId: id, repliedAt: null, repliedByMessageId: null, replyMethod: null, responseMinutes: null, responseBusinessMinutes: null };
}

/**
 * Decides repliedAt / repliedBy / method for every message of ONE thread.
 * Rules, first match wins: Outlook verb → header match → conversation match.
 * Outbound, auto-reply and own-address messages get an empty result. Sent
 * messages of other mailboxes in the company (`extraOutbound`) are reply
 * candidates too, so an email a colleague answered is not "waiting" for us.
 */
export function detectReplies(messages: ReplyInputMessage[], opts: DetectOptions): ReplyResult[] {
  const own = new Set(messages.map((m) => m.id));
  const outbound = [
    ...messages.filter((m) => isRealOutbound(m, opts.owners)),
    ...(opts.extraOutbound ?? []).filter((m) => m.direction === "outbound" && !m.isAutoReply && !own.has(m.id)),
  ].sort(byTime);

  return messages.map((m) => {
    if (!isRealInbound(m, opts.owners)) return emptyResult(m.id);

    const linked = headerMatch(m, outbound) ?? conversationMatch(m, outbound);
    let repliedAt: Date | null = null;
    let method: ReplyMethod | null = null;

    // 1. Outlook verb (reply / reply-all). Forward (104) is not a reply. Never earlier than receipt.
    if (m.lastVerb != null && REPLY_VERBS.has(m.lastVerb) && m.lastVerbAt && m.lastVerbAt.getTime() >= m.receivedAt.getTime()) {
      repliedAt = m.lastVerbAt;
      method = "outlook_verb";
    }
    // 2./3. Sent Items match. When the verb already gave a time we keep it but still link the sent message.
    if (linked) {
      if (!repliedAt) {
        repliedAt = effectiveTime(linked);
        method = isHeaderLinked(m, linked) ? "header_match" : "conversation_match";
      }
    }

    if (!repliedAt) return emptyResult(m.id);
    return {
      messageId: m.id,
      repliedAt,
      repliedByMessageId: linked?.id ?? null,
      replyMethod: method,
      responseMinutes: rawMinutesBetween(m.receivedAt, repliedAt),
      responseBusinessMinutes: businessMinutesBetween(m.receivedAt, repliedAt, opts.businessHours),
    };
  });
}

// ---------------------------------------------------------------------------
// Thread status

export interface ThreadState {
  status: ThreadStatus;
  /** false when a user or the AI decided no reply is needed */
  needsReply: boolean;
  /**
   * When the needsReply decision was made. A real inbound message newer than
   * this resets the decision (needsReply → true) until the AI re-summarizes.
   * null = legacy/undecided: the current value is kept as is.
   */
  needsReplyDecidedAt?: Date | null;
  /** set when a user or the AI closed the thread */
  closedAt: Date | null;
}

export interface StatusOptions extends DetectOptions {
  /** Reply SLA in business hours */
  slaHours: number;
  now?: Date;
}

export interface StatusResult {
  status: ThreadStatus;
  /** Effective needsReply after applying the reset rule */
  needsReply: boolean;
  /** true when a newer inbound message invalidated a previous needsReply decision */
  decisionReset: boolean;
  /** receivedAt of the oldest unanswered inbound message we owe a reply to (awaiting_us only) */
  awaitingSince: Date | null;
  /** instant at which the SLA expires (awaiting_us only) */
  overdueAt: Date | null;
  isOverdue: boolean;
}

/**
 * Thread status rules (SPEC §6):
 *  - awaiting_us: latest real message is inbound and unanswered (and needsReply isn't false)
 *  - awaiting_them: latest real message is outbound (or the latest inbound was answered)
 *  - no_reply_needed / closed are sticky, except a NEW inbound after a manual close reopens the thread.
 * Auto-replies are ignored for "latest real message"; own-address messages count as ours.
 */
export function computeThreadStatus(
  messages: ReplyInputMessage[],
  replies: ReplyResult[],
  current: ThreadState,
  opts: StatusOptions,
): StatusResult {
  const now = opts.now ?? new Date();
  const replyById = new Map(replies.map((r) => [r.messageId, r]));
  const real = messages.filter((m) => !m.isAutoReply).sort(byTime);

  // A real inbound message newer than the last needsReply decision resets it: the
  // thread needs a reply again until a user or the AI decides otherwise.
  const decidedAt = current.needsReplyDecidedAt ?? null;
  const decisionReset =
    !current.needsReply &&
    decidedAt != null &&
    real.some((m) => !isFromUs(m, opts.owners) && effectiveTime(m).getTime() > decidedAt.getTime());
  const needsReply = current.needsReply || decisionReset;
  const none = (status: ThreadStatus): StatusResult => ({ status, needsReply, decisionReset, awaitingSince: null, overdueAt: null, isOverdue: false });

  if (!real.length) {
    return none(current.status === "closed" ? "closed" : "no_reply_needed");
  }
  const latest = real[real.length - 1]!;

  if (current.status === "closed") {
    const reopened = real.some((m) => !isFromUs(m, opts.owners) && current.closedAt != null && effectiveTime(m).getTime() > current.closedAt.getTime());
    if (!reopened) return none("closed");
  }
  if (current.status === "no_reply_needed" && !needsReply) return none("no_reply_needed");

  if (isFromUs(latest, opts.owners)) return none("awaiting_them");
  const latestReply = replyById.get(latest.id);
  if (latestReply?.repliedAt) return none("awaiting_them");
  if (!needsReply) return none("no_reply_needed");

  // Waiting since the oldest unanswered inbound message that arrived after our last real message
  // (or after the manual close / the invalidated needsReply decision, when a thread is being reopened).
  let floor = current.status === "closed" && current.closedAt ? current.closedAt.getTime() : 0;
  if (decisionReset && decidedAt) floor = Math.max(floor, decidedAt.getTime());
  for (const m of real) if (isFromUs(m, opts.owners)) floor = Math.max(floor, effectiveTime(m).getTime());
  const pending = real.filter(
    (m) => !isFromUs(m, opts.owners) && !replyById.get(m.id)?.repliedAt && effectiveTime(m).getTime() > floor,
  );
  const awaitingSince = pending[0] ? pending[0].receivedAt : latest.receivedAt;
  const overdueAt = addBusinessMinutes(awaitingSince, opts.slaHours * 60, opts.businessHours);
  return {
    status: "awaiting_us",
    needsReply,
    decisionReset,
    awaitingSince,
    overdueAt,
    isOverdue: overdueAt != null && overdueAt.getTime() <= now.getTime(),
  };
}
