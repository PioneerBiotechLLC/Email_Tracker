/**
 * Folders that hold sent mail outside the real Sent Items folder. A migration
 * (e.g. Zoho → Microsoft 365 over IMAP) often copies the old provider's sent
 * folder as a plain folder named "Sent", "Sent Emails", "Emails Sent", …
 */
const SENT_NAMES = new Set([
  "sent", "sent items", "sent item", "sent mail", "sent mails", "sent email", "sent emails", "sent messages",
  "email sent", "emails sent", "mail sent", "outbox sent",
  "المرسلة", "العناصر المرسلة", "البريد المرسل", "الرسائل المرسلة",
]);

/** Lower-cased, punctuation-free, single-spaced folder name ("Sent-Mail" → "sent mail"). */
export function normalizeFolderName(name: string): string {
  return name.toLowerCase().replace(/[\s_.\-]+/g, " ").trim();
}

/** Whether a folder's name says it holds sent mail (the real Sent Items folder is told apart by id, not by name). */
export function looksLikeSentFolder(displayName: string): boolean {
  return SENT_NAMES.has(normalizeFolderName(displayName));
}
