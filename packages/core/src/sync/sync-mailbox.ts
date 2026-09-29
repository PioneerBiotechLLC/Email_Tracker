import { getDb, type Mailbox, type PrismaClient, type Prisma } from "../db.js";
import { protectBody } from "../crypto.js";
import { getEnv } from "../env.js";
import { createLogger } from "../log.js";
import { GraphProvider } from "../mail/graph-provider.js";
import { extractReplyHeaders, normalizeMessageId } from "../mail/headers.js";
import type { MailProvider, RawMessage, SyncFolder } from "../mail/provider.js";
import { normalizeSubject } from "../mail/subject.js";
import { cleanBody } from "../mail/text.js";
import { ownerAddresses, recomputeThread } from "./threads.js";

const log = createLogger("sync");

export interface SyncOptions {
  /** Ignore saved delta links and re-run the initial backfill. */
  reset?: boolean;
  /** Override BACKFILL_DAYS for the initial backfill. */
  backfillDays?: number;
  provider?: MailProvider;
}

export interface SyncStats {
  mailbox: string;
  folders: Record<SyncFolder, { pages: number; upserted: number; skippedDrafts: number; removed: number }>;
  threadsRecomputed: number;
  /** conversation ids that received new/updated messages (for AI summarization) */
  touchedConversationIds: string[];
  durationMs: number;
}

const FOLDERS: SyncFolder[] = ["inbox", "sentitems"];

/** Upserts one Graph message (and its thread shell). Returns the conversation id touched. */
async function upsertMessage(db: PrismaClient, mailbox: Mailbox, folder: SyncFolder, raw: RawMessage, owners: Set<string>): Promise<string> {
  const conversationId = raw.conversationId ?? `noconv:${raw.id}`;
  const fromAddress = raw.from?.address ?? "";
  const direction: "inbound" | "outbound" =
    folder === "sentitems" || (fromAddress && owners.has(fromAddress)) ? "outbound" : "inbound";
  const { inReplyTo, references, isAutoReply } = extractReplyHeaders(raw.headers, raw.subject);
  const body = cleanBody(raw.body, raw.bodyPreview);
  const stored = protectBody(body);
  const orderAt = direction === "outbound" && raw.sentAt ? raw.sentAt : raw.receivedAt;

  const thread = await db.thread.upsert({
    where: { mailboxId_conversationId: { mailboxId: mailbox.id, conversationId } },
    create: {
      mailboxId: mailbox.id,
      conversationId,
      subject: raw.subject,
      normalizedSubject: normalizeSubject(raw.subject),
      firstMessageAt: orderAt,
      lastMessageAt: orderAt,
      messageCount: 0,
    },
    update: {},
    select: { id: true },
  });

  const data = {
    mailboxId: mailbox.id,
    threadId: thread.id,
    conversationId,
    internetMessageId: normalizeMessageId(raw.internetMessageId),
    inReplyTo,
    references,
    direction,
    folder: folder === "sentitems" ? ("sent" as const) : ("inbox" as const),
    fromAddress,
    fromName: raw.from?.name ?? null,
    toAddresses: raw.to as unknown as Prisma.InputJsonValue,
    ccAddresses: raw.cc as unknown as Prisma.InputJsonValue,
    subject: raw.subject,
    receivedAt: orderAt,
    sentAt: raw.sentAt,
    bodyPreview: raw.bodyPreview?.slice(0, 500) ?? null,
    bodyText: stored.bodyText,
    bodyEncrypted: stored.bodyEncrypted,
    hasAttachments: raw.hasAttachments,
    importance: raw.importance,
    isAutoReply,
    lastVerb: raw.lastVerb,
    lastVerbAt: raw.lastVerbAt,
  };

  await db.message.upsert({
    where: { graphMessageId: raw.id },
    create: { graphMessageId: raw.id, ...data },
    update: data,
  });
  return conversationId;
}

/**
 * Backfill + incremental sync for one mailbox (SPEC §5.1). Safe to re-run:
 * resumes from the saved delta/next link, or starts a fresh backfill with `reset`.
 */
export async function syncMailbox(mailboxId: string, opts: SyncOptions = {}): Promise<SyncStats> {
  const db = getDb();
  try {
    const stats = await syncMailboxInner(db, mailboxId, opts);
    await db.mailbox.update({ where: { id: mailboxId }, data: { lastSyncError: null, lastSyncErrorAt: null } });
    return stats;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.mailbox.update({ where: { id: mailboxId }, data: { lastSyncError: message.slice(0, 500), lastSyncErrorAt: new Date() } }).catch(() => undefined);
    throw err;
  }
}

async function syncMailboxInner(db: PrismaClient, mailboxId: string, opts: SyncOptions): Promise<SyncStats> {
  const started = Date.now();
  const mailbox = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId }, include: { org: true } });
  const provider = opts.provider ?? new GraphProvider(mailbox.org.azureTenantId);
  const owners = ownerAddresses(mailbox);
  const sinceDays = opts.backfillDays ?? getEnv().BACKFILL_DAYS;
  const touched = new Set<string>();

  const stats: SyncStats = {
    mailbox: mailbox.emailAddress,
    folders: {
      inbox: { pages: 0, upserted: 0, skippedDrafts: 0, removed: 0 },
      sentitems: { pages: 0, upserted: 0, skippedDrafts: 0, removed: 0 },
    },
    threadsRecomputed: 0,
    touchedConversationIds: [],
    durationMs: 0,
  };

  for (const folder of FOLDERS) {
    const linkField = folder === "inbox" ? "inboxDeltaLink" : "sentDeltaLink";
    const savedLink = opts.reset ? null : mailbox[linkField];
    const fstats = stats.folders[folder];
    log.info(`syncing ${folder}`, { mailbox: mailbox.emailAddress, mode: savedLink ? "incremental" : `backfill ${sinceDays}d` });

    const saveLink = (link: string) => db.mailbox.update({ where: { id: mailbox.id }, data: { [linkField]: link } });

    const gen = provider.listChanges({
      userId: mailbox.graphUserId,
      folder,
      deltaLink: savedLink,
      sinceDays,
      onProgress: (link) => saveLink(link).then(() => undefined),
    });

    for (;;) {
      const step = await gen.next();
      if (step.done) {
        await saveLink(step.value.deltaLink);
        break;
      }
      const page = step.value;
      fstats.pages += 1;
      fstats.removed += page.removedIds.length;
      for (const raw of page.messages) {
        if (raw.isDraft) {
          fstats.skippedDrafts += 1;
          continue;
        }
        touched.add(await upsertMessage(db, mailbox, folder, raw, owners));
        fstats.upserted += 1;
      }
      log.debug(`page done`, { folder, page: fstats.pages, messages: page.messages.length });
    }
    log.info(`${folder} done`, { ...fstats });
  }

  for (const conversationId of touched) {
    await recomputeThread(db, mailbox.id, conversationId);
    stats.threadsRecomputed += 1;
  }

  stats.touchedConversationIds = Array.from(touched);
  await db.mailbox.update({ where: { id: mailbox.id }, data: { lastSyncedAt: new Date() } });
  stats.durationMs = Date.now() - started;
  log.info("sync complete", { mailbox: mailbox.emailAddress, threads: stats.threadsRecomputed, ms: stats.durationMs });
  return stats;
}
