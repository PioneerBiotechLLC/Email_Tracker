import { z } from "zod";
import { zonedTimeToUtc } from "./sync/business-hours.js";

/** Typed view of the free-form `Organization.settings` JSON. Unknown or malformed values fall back to the defaults. */
const schema = z.object({
  /** Built-in detection of bulk / automatic mail (List-Unsubscribe, noreply senders, …) */
  autoExclude: z.boolean().catch(true),
  /** Treat mail that Outlook's Focused Inbox files under "Other" as no_reply_needed */
  outlookOtherNoReply: z.boolean().catch(true),
  /** Mail from a colleague (sender in the company's own domains) needs no reply */
  internalNoReply: z.boolean().catch(true),
  /** Index words from email bodies for search; false = subject and participants only */
  searchIndexBodies: z.boolean().catch(true),
  /** Reply tracking starts on this local day (YYYY-MM-DD, company timezone); earlier emails never wait for a reply. null = all mail */
  trackRepliesFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
});

export function orgSettings(json: unknown): z.infer<typeof schema> {
  return schema.parse(json && typeof json === "object" && !Array.isArray(json) ? json : {});
}

/** Start of the company's reply tracking (midnight of `trackRepliesFrom` in the company timezone), or null when all mail is tracked. */
export function trackingStart(org: { settings: unknown; timezone: string }): Date | null {
  const day = orgSettings(org.settings).trackRepliesFrom;
  if (!day) return null;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc(y, m, d, 0, 0, org.timezone);
}
