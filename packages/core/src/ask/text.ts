/**
 * Text handling for the search index and the "Ask" tools. The same
 * normalization runs when a message is indexed and when a query is built, so
 * both sides always agree. Pure functions (unit-tested).
 *
 * Postgres indexes the normalized text with the 'simple' configuration: no
 * stemming and no stop words, so Arabic words and product codes match exactly.
 * What we normalize ourselves:
 *  - letters and digits are separate tokens, and every other character is a
 *    separator: "PO-4512", "PO#4512", "PO4512" and "INV/2026/4512" all contain
 *    the token "4512";
 *  - Arabic-Indic digits become 0-9; Arabic diacritics and tatweel are dropped;
 *    alef / ya / ta-marbuta spelling variants and a leading definite article are
 *    folded, so "الإنسولين" and "انسولين" meet.
 */

const DIACRITICS_RE = /[ً-ٰٟـ]/g;
const ARABIC_ARTICLE_RE = /^(?:[وفبكل]?ال|لل)(?=[ء-ي]{3,}$)/;
const TOKEN_RE = /\p{L}+|\p{N}+/gu;

function foldChars(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(DIACRITICS_RE, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

/** Normalized tokens of any text, in order (duplicates kept). */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return (foldChars(text).match(TOKEN_RE) ?? []).map((t) => t.replace(ARABIC_ARTICLE_RE, ""));
}

/** Upper bound on tokens indexed per message (an 8,000-character body is about 1,500). */
const MAX_INDEX_TOKENS = 4000;

/** The text handed to `to_tsvector('simple', …)`: normalized tokens separated by spaces. */
export function searchText(parts: (string | null | undefined)[]): string {
  return parts.flatMap(tokenize).slice(0, MAX_INDEX_TOKENS).join(" ");
}

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "for", "to", "in", "on", "at", "by", "and", "or", "is", "are", "was", "were", "be", "been", "what", "which", "who", "when", "where", "how", "why",
  "about", "from", "with", "any", "our", "we", "us", "you", "your", "did", "do", "does", "has", "have", "had", "me", "my", "it", "its", "this", "that", "there", "please", "re", "fw", "fwd",
  "من", "في", "علي", "عن", "الي", "ما", "هل", "هو", "هي", "هذا", "هذه", "تم", "مع", "او", "و",
]);

const isNumber = (t: string) => /^\p{N}+$/u.test(t);
/** Numbers that say little on their own: one or two digits, and years. */
const isWeakNumber = (t: string) => isNumber(t) && (t.length < 3 || /^(?:19|20)\d\d$/.test(t));

/**
 * `to_tsquery('simple', …)` strings for a search, strictest first. The caller
 * runs them in order until it has enough hits:
 *  1. every term must match;
 *  2. the identifying numbers alone ("PO 4512" also finds "INV/2026/4512" and a bare "4512");
 *  3. any of the meaningful terms.
 * Tokens contain only letters or digits, so they cannot carry tsquery operators.
 */
export function searchPlans(query: string): string[] {
  const tokens = [...new Set(tokenize(query))].filter((t) => !STOP_WORDS.has(t) && (isNumber(t) || t.length > 1));
  if (!tokens.length) return [];
  const numbers = tokens.filter(isNumber);
  const strong = numbers.some((t) => !isWeakNumber(t)) ? numbers.filter((t) => !isWeakNumber(t)) : numbers.filter((t) => t.length >= 3);
  const meaningful = tokens.filter((t) => !isWeakNumber(t));
  const plans = [tokens.join(" & ")];
  if (strong.length) plans.push(strong.join(" & "), strong.join(" | "));
  if (meaningful.length) plans.push(meaningful.join(" | "));
  return [...new Set(plans)];
}

/** About `max` characters of the text around the first term of the query that occurs in it. */
export function snippet(text: string, query: string | null | undefined, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const wanted = new Set(tokenize(query));
  let at = 0;
  if (wanted.size) {
    for (const m of clean.matchAll(TOKEN_RE)) {
      if (tokenize(m[0]).some((t) => wanted.has(t))) {
        at = m.index;
        break;
      }
    }
  }
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), clean.length - max));
  return `${start > 0 ? "…" : ""}${clean.slice(start, start + max).trim()}${start + max < clean.length ? "…" : ""}`;
}
