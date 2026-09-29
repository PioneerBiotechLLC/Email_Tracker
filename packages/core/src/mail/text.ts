import { convert } from "html-to-text";

export const BODY_MAX_CHARS = 8000;

/** HTML → readable plain text (links kept as text, no wrapping). */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    preserveNewlines: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "head", format: "skip" },
    ],
  });
}

// --- quoted-history markers -------------------------------------------------

/** A line that begins a quoted-history block; everything from here on is dropped. */
const HISTORY_LINE_RES: RegExp[] = [
  /^-{2,}\s*Original (?:Message|Appointment)\s*-{2,}$/i,
  /^-{2,}\s*Forwarded message\s*-{2,}$/i,
  /^_{10,}$/, // Outlook divider
  /^-{10,}$/,
  /^On .{3,200}? wrote:\s*$/i,
  /^Le .{3,200}? a écrit\s*:\s*$/i,
  /^Am .{3,200}? schrieb .*:\s*$/i,
  /^في .{3,200}?كتب.*:\s*$/, // Arabic "On ... wrote:"
  /^بتاريخ .{3,200}?كتب.*:\s*$/,
  /^-{2,}\s*الرسالة الأصلية\s*-{2,}$/,
  /^>\s?/, // quoted line
];

/** Outlook-style header block: "From: …" followed (within a few lines) by Sent/To/Subject. */
const HEADER_FIRST_RE = /^(?:\*\*)?(from|de|von|من)(?:\*\*)?\s*:/i;
const HEADER_FOLLOW_RE = /^(?:\*\*)?(sent|to|cc|subject|date|envoyé|à|objet|gesendet|an|betreff|تاريخ الإرسال|إرسال|إلى|الموضوع|التاريخ)(?:\*\*)?\s*:/i;

function isHistoryStart(lines: string[], i: number): boolean {
  const line = lines[i]!.trim();
  if (!line) return false;
  for (const re of HISTORY_LINE_RES) if (re.test(line)) return true;
  // "On ... wrote:" can wrap over two lines.
  if (/^On .{3,200}$/i.test(line) && /wrote:\s*$/i.test((lines[i + 1] ?? "").trim())) return true;
  if (HEADER_FIRST_RE.test(line)) {
    let hits = 0;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      if (HEADER_FOLLOW_RE.test(lines[j]!.trim())) hits++;
    }
    if (hits >= 2) return true;
  }
  return false;
}

/** Drops quoted history (everything after the first reply/forward marker). */
export function stripQuotedHistory(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (isHistoryStart(lines, i)) return lines.slice(0, i).join("\n");
  }
  return text;
}

// --- signatures -------------------------------------------------------------

const SIGNOFF_RE =
  /^(?:--\s*$|__+\s*$|(?:best|kind|warm|many)?\s*(?:regards|wishes|thanks(?: and regards)?|thank you|cheers|sincerely|yours (?:sincerely|faithfully|truly))\s*[,.!]?\s*$|(?:مع )?(?:أطيب |خالص |فائق )?(?:التحية|التحيات|تحياتي|الاحترام|الشكر|التقدير)\s*[,،.]?\s*$|شكرا\s*[,،.]?\s*$|شكراً\s*[,،.]?\s*$|وتفضلوا بقبول فائق الاحترام.*$|sent from my .{0,40}$|get outlook for (?:ios|android)\s*$|sent from outlook for (?:ios|android)\s*$)/i;

/**
 * Removes a trailing signature block. Only cuts at a sign-off line that
 * appears after at least a third of the content so a bare "Thanks," message survives.
 */
export function stripSignature(text: string): string {
  const lines = text.split("\n");
  const minIndex = Math.floor(lines.length / 3);
  for (let i = lines.length - 1; i >= minIndex; i--) {
    const line = lines[i]!.trim();
    if (SIGNOFF_RE.test(line)) {
      // Include the sign-off line itself only if it isn't the sole content.
      const keep = lines.slice(0, i);
      if (keep.join("").trim().length > 0) return keep.join("\n");
      return text;
    }
  }
  return text;
}

/** Collapses whitespace: trims lines, max one blank line in a row, no NBSP. */
export function tidyWhitespace(text: string): string {
  return text
    .replace(/ /g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface CleanBodyInput {
  contentType: "text" | "html" | string;
  content: string;
}

/**
 * Full pipeline used by the sync engine (SPEC §5.1): HTML → text, drop quoted
 * history and signature, tidy, cap at 8000 chars.
 */
export function cleanBody(body: CleanBodyInput | null | undefined, fallbackPreview?: string | null): string {
  if (!body?.content) return tidyWhitespace(fallbackPreview ?? "");
  const text = body.contentType.toLowerCase() === "html" ? htmlToText(body.content) : body.content;
  let out = tidyWhitespace(stripSignature(stripQuotedHistory(tidyWhitespace(text))));
  if (!out) out = tidyWhitespace(fallbackPreview ?? "");
  if (out.length > BODY_MAX_CHARS) out = out.slice(0, BODY_MAX_CHARS) + "\n…[truncated]";
  return out;
}
