import { messageSearchText, writeMessageVectors } from "../ask/search-index.js";
import { getDb, type Mailbox, type PrismaClient, type Prisma } from "../db.js";
import { protectBody } from "../crypto.js";
import { getEnv } from "../env.js";
import { createLogger } from "../log.js";
import { GraphProvider } from "../mail/graph-provider.js";
import { extractReplyHeaders, normalizeMessageId } from "../mail/headers.js";
import type { MailProvider, RawMessage, SyncFolder } from "../mail/provider.js";
import { normalizeSubject } from "../mail/subject.js";
import { cleanBody } from "../mail/text.js";
import { orgSettings } from "../org-settings.js";
import { dedupeMessageIds, internalRecipients, orgDomains, threadRefKey, type ThreadRef } from "./dedupe.js";
import { loadExclusionContext, type ExclusionContext } from "./exclusion-rules.js";
import { evaluateExclusion, headerSignals } from "./exclusions.js";
import { ownerAddresses, recomputeSiblingThreads, recomputeThread } from "./threads.js";

const log = createLogger("sync");

export interface SyncOptions {
  /** Ignore saved delta links and re-run the initial backfill. */
  reset?: boolean;
  /** Stop after the current page once this time passes (serverless time limits); progress is saved and resumes next run. */
  deadlineAt?: Date;
  /** Override BACKFILL_DAYS for the initial backfill. */
  backfillDays?: number;
  provider?: MailProvider;
}

export interface SyncStats {
  mailbox: string;
  folders: Record<SyncFolder, { pages: number; upserted: number; skippedDrafts: number; removed: number }>;
  threadsRecomputed: number;
  /** threads of the company's other mailboxes recomputed because they share a conversation or a copied email */
  siblingThreadsRecomputed: number;
  /** messages of this run that turned out to be copies of mail already tracked in another mailbox */
  duplicates: number;
  /** conversation ids that received new/updated messages (for AI summarization) */
  touchedConversationIds: string[];
  /** true when the deadline stopped the sync before both folders were complete */
  partial: boolean;
  durationMs: number;
}

const FOLDERS: SyncFolder[] = ["inbox", "sentitems"];

interface UpsertContext {
  owners: Set<string>;
  /** the company's email domains, for internal-recipient detection */
  domains: Set<string>;
  previewOnly: boolean;
  /** index words from email bodies for search (company setting); otherwise subject + participants only */
  indexBodies: boolean;
  /** the company's exclusion rules and detection settings, loaded once per sync */
  exclusions: ExclusionContext;
}

/** Upserts one Graph message (and its thread shell). Returns the conversation id and Message-ID touched, and the text for the search index. */
async function upsertMessage(db: PrismaClient, mailbox: Mailbox, folder: SyncFolder, raw: RawMessage, ctx: UpsertContext): Promise<{ conversationId: string; internetMessageId: string | null; searchText: string }> {
  const { owners, previewOnly } = ctx;
  const conversationId = raw.conversationId ?? `noconv:${raw.id}`;
  const fromAddress = raw.from?.address ?? "";
  const direction: "inbound" | "outbound" =
    folder === "sentitems" || (fromAddress && owners.has(fromAddress)) ? "outbound" : "inbound";
  const { inReplyTo, references, isAutoReply } = extractReplyHeaders(raw.headers, raw.subject);
  const body = cleanBody(raw.body, raw.bodyPreview);
  // "preview only" storage keeps the DB small: no body text, the 500-char preview only.
  const stored = previewOnly ? { bodyText: null, bodyEncrypted: false } : protectBody(body);
  const orderAt = direction === "outbound" && raw.sentAt ? raw.sentAt : raw.receivedAt;
  // Exclusion rules run here, before reply detection and the AI ever see the message. Only incoming mail is excluded.
  const autoSignals = headerSignals(raw.headers);
  const exclusion =
    direction === "inbound"
      ? evaluateExclusion({ mailboxId: mailbox.id, fromAddress, subject: raw.subject, autoSignals, inferenceClassification: raw.inferenceClassification }, ctx.exclusions.rules, ctx.exclusions.settings)
      : { excludedBy: null, exclusionAction: null };

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

  const internetMessageId = normalizeMessageId(raw.internetMessageId);
  const data = {
    mailboxId: mailbox.id,
    threadId: thread.id,
    conversationId,
    internetMessageId,
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
    // Colleagues (addresses in the company's domains) who also got this email
    internalRecipients: internalRecipients({ to: raw.to, cc: raw.cc }, ctx.domains, owners),
    inferenceClassification: raw.inferenceClassification,
    webLink: raw.webLink,
    autoSignals,
    ...exclusion,
  };

  await db.message.upsert({
    where: { graphMessageId: raw.id },
    create: { graphMessageId: raw.id, ...data },
    update: data,
  });
  // The search index is built from plaintext here because the stored body may be encrypted (or not stored at all).
  const indexedBody = !ctx.indexBodies ? null : previewOnly ? raw.bodyPreview : body;
  return { conversationId, internetMessageId, searchText: messageSearchText({ subject: raw.subject, fromName: raw.from?.name ?? null, fromAddress, to: raw.to, cc: raw.cc, body: indexedBody }) };
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
  if (!opts.provider && !mailbox.org.azureTenantId) throw new Error(`Company ${mailbox.org.name} is not connected to Microsoft 365 yet (no tenant id)`);
  const provider = opts.provider ?? new GraphProvider(mailbox.org.azureTenantId!);
  const owners = ownerAddresses(mailbox);
  const sinceDays = opts.backfillDays ?? getEnv().BACKFILL_DAYS;
  const touched = new Set<string>();
  // Threads in the company's OTHER mailboxes whose messages were (un)linked as copies during this run
  const siblingTouched = new Map<string, ThreadRef>();

  const stats: SyncStats = {
    mailbox: mailbox.emailAddress,
    folders: {
      inbox: { pages: 0, upserted: 0, skippedDrafts: 0, removed: 0 },
      sentitems: { pages: 0, upserted: 0, skippedDrafts: 0, removed: 0 },
    },
    threadsRecomputed: 0,
    siblingThreadsRecomputed: 0,
    duplicates: 0,
    touchedConversationIds: [],
    partial: false,
    durationMs: 0,
  };
  const ctx: UpsertContext = { owners, domains: orgDomains(mailbox.org), previewOnly: mailbox.org.bodyStorage === "preview_only", indexBodies: orgSettings(mailbox.org.settings).searchIndexBodies, exclusions: await loadExclusionContext(db, mailbox.orgId) };

  for (const folder of FOLDERS) {
    if (stats.partial) break;
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
        if (step.value.deltaLink) await saveLink(step.value.deltaLink);
        break;
      }
      const page = step.value;
      fstats.pages += 1;
      fstats.removed += page.removedIds.length;
      const messageIds: string[] = [];
      const vectors: { key: string; text: string }[] = [];
      for (const raw of page.messages) {
        if (raw.isDraft) {
          fstats.skippedDrafts += 1;
          continue;
        }
        const r = await upsertMessage(db, mailbox, folder, raw, ctx);
        touched.add(r.conversationId);
        if (r.internetMessageId) messageIds.push(r.internetMessageId);
        vectors.push({ key: raw.id, text: r.searchText });
        fstats.upserted += 1;
      }
      // One statement per page for the search index (Prisma cannot write tsvector columns in the upsert itself).
      await writeMessageVectors(db, "graphMessageId", vectors);
      // The same email may already be tracked in another mailbox of the company (we were Cc'd): link the copies.
      const dedupe = await dedupeMessageIds(db, mailbox.orgId, messageIds);
      stats.duplicates += dedupe.duplicates;
      for (const ref of dedupe.changed) {
        if (ref.mailboxId === mailbox.id) touched.add(ref.conversationId);
        else siblingTouched.set(threadRefKey(ref), ref);
      }
      log.debug(`page done`, { folder, page: fstats.pages, messages: page.messages.length });
      if (opts.deadlineAt && Date.now() >= opts.deadlineAt.getTime()) {
        // The nextLink for this page was already saved by onProgress; the next run continues from it.
        log.info("deadline reached; sync will resume on the next run", { folder, pages: fstats.pages });
        stats.partial = true;
        await gen.return({ deltaLink: "" });
        break;
      }
    }
    log.info(`${folder} done`, { ...fstats });
  }

  for (const conversationId of touched) {
    await recomputeThread(db, mailbox.id, conversationId);
    stats.threadsRecomputed += 1;
  }
  // Other mailboxes of the company: threads that share a conversation with new mail here (a reply sent from
  // this mailbox answers their copy too) and threads whose messages were re-linked as copies.
  for (const ref of siblingTouched.values()) {
    await recomputeThread(db, ref.mailboxId, ref.conversationId);
    stats.siblingThreadsRecomputed += 1;
  }
  stats.siblingThreadsRecomputed += await recomputeSiblingThreads(db, mailbox.orgId, mailbox.id, Array.from(touched), new Set(siblingTouched.keys()));

  stats.touchedConversationIds = Array.from(touched);
  await db.mailbox.update({ where: { id: mailbox.id }, data: { lastSyncedAt: new Date() } });
  stats.durationMs = Date.now() - started;
  log.info("sync complete", { mailbox: mailbox.emailAddress, threads: stats.threadsRecomputed, siblingThreads: stats.siblingThreadsRecomputed, duplicates: stats.duplicates, ms: stats.durationMs });
  return stats;
}

const LOCK_STALE_MS = 10 * 60_000;

/** Takes the per-mailbox sync lock (webhook and cron may overlap). Returns false when another sync is running. */
export async function acquireSyncLock(db: PrismaClient, mailboxId: string, now = new Date()): Promise<boolean> {
  const r = await db.mailbox.updateMany({
    where: { id: mailboxId, OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: new Date(now.getTime() - LOCK_STALE_MS) } }] },
    data: { syncLockedAt: now },
  });
  return r.count === 1;
}

export async function releaseSyncLock(db: PrismaClient, mailboxId: string): Promise<void> {
  await db.mailbox.update({ where: { id: mailboxId }, data: { syncLockedAt: null } }).catch(() => undefined);
}

/** Sync with the lock held; returns null when the mailbox is already being synced. */
export async function syncMailboxLocked(mailboxId: string, opts: SyncOptions = {}): Promise<SyncStats | null> {
  const db = getDb();
  if (!(await acquireSyncLock(db, mailboxId))) return null;
  try {
    return await syncMailbox(mailboxId, opts);
  } finally {
    await releaseSyncLock(db, mailboxId);
  }
}
