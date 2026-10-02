import type { PrismaClient } from "../db.js";
import { GraphProvider } from "../mail/graph-provider.js";
import type { MailProvider } from "../mail/provider.js";

interface WebLinkBackfillResult {
  mailboxes: number;
  /** messages that got their Outlook link */
  linked: number;
  /** messages that no longer exist in the mailbox (marked so they are not asked for again) */
  gone: number;
  /** lookups that failed for another reason; the next run retries them */
  failed: number;
}

const CHUNK = 100;

/**
 * Fills `Message.webLink` ("Open in Outlook") for mail synced before links were
 * stored. Read-only on the mailbox: $batch GETs of `webLink`, 20 per request,
 * with the same throttling handling as the sync. Resumable: only rows without a
 * link are fetched, and every chunk is saved before the next one starts.
 */
export async function backfillWebLinks(db: PrismaClient, orgId: string, opts: { provider?: MailProvider; onProgress?: (mailbox: string, done: number, total: number) => void } = {}): Promise<WebLinkBackfillResult> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { name: true, azureTenantId: true, mailboxes: { select: { id: true, emailAddress: true, graphUserId: true }, orderBy: { emailAddress: "asc" } } } });
  if (!opts.provider && !org.azureTenantId) throw new Error(`Company ${org.name} is not connected to Microsoft 365 yet (no tenant id)`);
  const provider = opts.provider ?? new GraphProvider(org.azureTenantId!);
  const out: WebLinkBackfillResult = { mailboxes: org.mailboxes.length, linked: 0, gone: 0, failed: 0 };
  for (const mb of org.mailboxes) {
    const total = await db.message.count({ where: { mailboxId: mb.id, webLink: null } });
    let done = 0;
    let cursor: string | undefined;
    for (;;) {
      const rows = await db.message.findMany({ where: { mailboxId: mb.id, webLink: null }, select: { id: true, graphMessageId: true }, orderBy: { id: "asc" }, take: CHUNK, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!rows.length) break;
      const links = await provider.getWebLinks(mb.graphUserId, rows.map((r) => r.graphMessageId));
      const found = rows.filter((r) => links.has(r.graphMessageId));
      // "" marks a message that is gone from the mailbox: no link to show, nothing to retry.
      await db.$transaction(found.map((r) => db.message.update({ where: { id: r.id }, data: { webLink: links.get(r.graphMessageId) ?? "" } })));
      const gone = found.filter((r) => !links.get(r.graphMessageId)).length;
      out.linked += found.length - gone;
      out.gone += gone;
      out.failed += rows.length - found.length;
      done += rows.length;
      opts.onProgress?.(mb.emailAddress, done, total);
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < CHUNK) break;
    }
  }
  return out;
}
