import type { RawHeader } from "./headers.js";

export interface RawRecipient {
  address: string;
  name?: string | null;
}

/** Provider-neutral message shape produced by any MailProvider. */
export interface RawMessage {
  id: string;
  changeKey?: string | null;
  conversationId: string | null;
  internetMessageId: string | null;
  subject: string;
  from: RawRecipient | null;
  to: RawRecipient[];
  cc: RawRecipient[];
  receivedAt: Date;
  sentAt: Date | null;
  bodyPreview: string;
  body: { contentType: "text" | "html"; content: string } | null;
  hasAttachments: boolean;
  importance: string;
  isDraft: boolean;
  /** Raw internet headers if the provider returned them */
  headers: RawHeader[] | null;
  /** PidTagLastVerbExecuted (102 reply, 103 reply-all, 104 forward) */
  lastVerb: number | null;
  lastVerbAt: Date | null;
  /** Link that opens the message in Outlook on the web */
  webLink: string | null;
  /** Outlook Focused Inbox classification ("focused" | "other") when the provider has one */
  inferenceClassification: string | null;
}

export type SyncFolder = "inbox" | "sentitems";

export interface DeltaPage {
  messages: RawMessage[];
  removedIds: string[];
}

export interface ListChangesOptions {
  userId: string;
  folder: SyncFolder;
  /** Saved delta/next link. When absent an initial backfill is started. */
  deltaLink?: string | null;
  /** Backfill window for the initial sync. */
  sinceDays: number;
  /** Called after each page with the link to resume from if interrupted. */
  onProgress?: (link: string) => Promise<void> | void;
}

export interface ListChangesResult {
  deltaLink: string;
}

export interface MailboxFolder {
  id: string;
  /** e.g. "Inbox/Sent" for a folder nested under the Inbox */
  path: string;
  displayName: string;
  totalItemCount: number;
  /** the mailbox's real Sent Items folder (already synced by listChanges) */
  isSentItems: boolean;
}

export interface MailUser {
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  proxyAddresses: string[];
}

export interface SubscriptionInfo {
  id: string;
  expiresAt: Date;
}

/**
 * All mailbox access goes through this interface (SPEC §5.3) so an IMAP/Zoho
 * provider can be added later. Providers are strictly read-only.
 */
export interface MailProvider {
  resolveUser(emailOrUpn: string): Promise<MailUser>;
  listChanges(opts: ListChangesOptions): AsyncGenerator<DeltaPage, ListChangesResult, void>;
  getMessages(userId: string, ids: string[]): Promise<RawMessage[]>;
  /** Every mail folder of the mailbox, nested ones included. */
  listMailFolders(userId: string): Promise<MailboxFolder[]>;
  /** Messages of one folder sent within the last `sinceDays` days, a page at a time (one-off imports, no delta tracking). */
  listFolderMessages(userId: string, folderId: string, sinceDays: number): AsyncGenerator<RawMessage[], void, void>;
  /** Outlook web links for messages synced before links were stored; null = the message no longer exists in the mailbox. */
  getWebLinks(userId: string, ids: string[]): Promise<Map<string, string | null>>;
  subscribe(userId: string, notificationUrl: string, clientState: string, lifecycleNotificationUrl?: string): Promise<SubscriptionInfo>;
  renew(subscriptionId: string): Promise<SubscriptionInfo>;
}
