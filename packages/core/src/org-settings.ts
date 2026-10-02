import { z } from "zod";

/** Typed view of the free-form `Organization.settings` JSON. Unknown or malformed values fall back to the defaults. */
const schema = z.object({
  /** Built-in detection of bulk / automatic mail (List-Unsubscribe, noreply senders, …) */
  autoExclude: z.boolean().catch(true),
  /** Treat mail that Outlook's Focused Inbox files under "Other" as no_reply_needed */
  outlookOtherNoReply: z.boolean().catch(true),
  /** Index words from email bodies for search; false = subject and participants only */
  searchIndexBodies: z.boolean().catch(true),
});

export function orgSettings(json: unknown): z.infer<typeof schema> {
  return schema.parse(json && typeof json === "object" && !Array.isArray(json) ? json : {});
}
