export interface RawHeader {
  name: string;
  value: string;
}

/** Lower-cased header map; repeated headers keep every value in order. */
export function headerMap(headers: RawHeader[] | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of headers ?? []) {
    const k = h.name.toLowerCase();
    (out[k] ??= []).push(h.value);
  }
  return out;
}

/** Extracts every <message-id> token from a header value (References may list many). */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  const bare = value.trim();
  return bare ? [bare.startsWith("<") ? bare : `<${bare}>`] : [];
}

export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const t = id.trim();
  if (!t) return null;
  return t.startsWith("<") ? t : `<${t}>`;
}

export interface ReplyHeaders {
  inReplyTo: string | null;
  references: string[];
  isAutoReply: boolean;
}

/**
 * Reads In-Reply-To / References and auto-reply markers from a message's headers.
 * Auto-replies (out-of-office etc.) must never count as a real reply (SPEC §6).
 */
export function extractReplyHeaders(headers: RawHeader[] | null | undefined, subject?: string | null): ReplyHeaders {
  const map = headerMap(headers);
  const inReplyTo = parseMessageIds(map["in-reply-to"]?.[0])[0] ?? null;
  const references = map["references"]?.flatMap(parseMessageIds) ?? [];

  const autoSubmitted = (map["auto-submitted"]?.[0] ?? "").toLowerCase();
  const suppress = map["x-auto-response-suppress"]?.[0];
  const precedence = (map["precedence"]?.[0] ?? "").toLowerCase();
  const xAutoReply = map["x-autoreply"]?.[0] ?? map["x-autorespond"]?.[0];
  const isAutoReply =
    (autoSubmitted !== "" && autoSubmitted !== "no") ||
    !!suppress ||
    precedence === "auto_reply" ||
    !!xAutoReply ||
    /^\s*(automatic reply|out of office|رد تلقائي)\s*:/i.test(subject ?? "");

  return { inReplyTo, references: Array.from(new Set(references)), isAutoReply };
}
