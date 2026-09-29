/**
 * Normalizes a subject so the same topic groups together across separate
 * conversation threads (SPEC §7.4): lowercase, strip RE/FW/FWD (English and
 * Arabic) prefixes repeatedly, drop [ticket-123] style brackets, collapse whitespace.
 */
const PREFIX_RE =
  /^\s*(?:(?:re|fw|fwd|aw|wg|tr|sv|vs|antw|رد|إعادة توجيه|اعادة توجيه|تحويل|الرد)\s*(?:\[\d+\])?\s*:\s*)+/i;
const AUTO_REPLY_RE = /^\s*(?:automatic reply|auto(?:matic)?[- ]reply|out of office|رد تلقائي)\s*:\s*/i;
const BRACKET_TAG_RE = /\[[^\]]{1,40}\]|\([^)]*#\d+[^)]*\)|#\d{3,}/g;

export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  // Strip auto-reply markers and reply/forward prefixes repeatedly (e.g. "RE: FW: RE: x").
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(AUTO_REPLY_RE, "").replace(PREFIX_RE, "");
    if (s === before) break;
  }
  s = s.replace(BRACKET_TAG_RE, " ");
  s = s.replace(/[​-‏﻿]/g, ""); // zero-width / RTL marks
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s || "(no subject)";
}

export function isAutoReplySubject(subject: string | null | undefined): boolean {
  return AUTO_REPLY_RE.test(subject ?? "");
}
