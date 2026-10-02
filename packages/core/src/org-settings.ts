import { z } from "zod";

/** Typed view of the free-form `Organization.settings` JSON. Unknown or malformed values fall back to the defaults. */
const schema = z.object({
  /** Built-in detection of bulk / automatic mail (List-Unsubscribe, noreply senders, …) */
  autoExclude: z.boolean().catch(true),
  /** Treat mail that Outlook's Focused Inbox files under "Other" as no_reply_needed */
  outlookOtherNoReply: z.boolean().catch(true),
});

export type OrgSettings = z.infer<typeof schema>;

export function orgSettings(json: unknown): OrgSettings {
  return schema.parse(json && typeof json === "object" && !Array.isArray(json) ? json : {});
}
