/**
 * Copies of the same email across a company's mailboxes.
 *
 * When two tracked mailboxes both receive one email (sales@ in To, regulatory@
 * in Cc) each mailbox gets its own Graph message id, so the sync stores one
 * row per mailbox. The rows share the RFC Message-ID, which is how we link
 * them: exactly one copy is the *primary* and the others point at it through
 * `duplicateOfId`. "All mailboxes" views and statistics only count primaries;
 * a single-mailbox view still shows everything that landed in that mailbox.
 *
 * The same pass records `internalRecipients`: which other addresses inside
 * the company's domains were in To/Cc ("who else in our company got this").
 *
 * Pure helpers first (unit-tested), DB wrappers below.
 */
import type { Prisma, PrismaClient } from "../db.js";
import { ownerAddresses } from "./threads.js";

export interface RecipientLike {
  address: string;
  name?: string | null;
}

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Lower-cased email domains that count as "our company" (primary domain + extra domains). */
export function orgDomains(org: { domain: string; domains?: string[] | null }): Set<string> {
  return new Set([org.domain, ...(org.domains ?? [])].map(lower).filter(Boolean));
}

export function domainOf(address: string): string {
  const a = lower(address);
  const at = a.lastIndexOf("@");
  return at > 0 ? a.slice(at + 1) : "";
}

/**
 * To/Cc addresses inside the company's domains, other than the receiving
 * mailbox's own addresses. Sorted and unique so it can be compared as a list.
 */
export function internalRecipients(msg: { to: RecipientLike[]; cc: RecipientLike[] }, domains: Set<string>, owners: Set<string>): string[] {
  const out = new Set<string>();
  for (const r of [...(msg.to ?? []), ...(msg.cc ?? [])]) {
    const a = lower(r?.address);
    if (!a || owners.has(a) || !domains.has(domainOf(a))) continue;
    out.add(a);
  }
  return [...out].sort();
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface MessageCopy {
  id: string;
  mailboxId: string;
  direction: "inbound" | "outbound";
  folder: "inbox" | "sent" | "other";
  fromAddress: string;
  toAddresses: RecipientLike[];
  ccAddresses: RecipientLike[];
  /** the copy's mailbox: address + aliases, lower-cased */
  owners: Set<string>;
  mailboxCreatedAt: Date;
}

/**
 * How "canonical" a copy is. The mailbox that sent the email keeps the primary
 * copy of an outbound message; for inbound mail the direct (To) recipient wins
 * over a Cc'd mailbox, which wins over anything else (e.g. delivery through a
 * distribution list). A Sent Items copy beats an Inbox copy of the same
 * outbound mail (people who email themselves).
 */
export function copyRank(c: MessageCopy): number {
  const has = (list: RecipientLike[]) => (list ?? []).some((r) => c.owners.has(lower(r?.address)));
  let rank = c.owners.has(lower(c.fromAddress)) ? 30 : has(c.toAddresses) ? 20 : has(c.ccAddresses) ? 10 : 0;
  if (c.folder === "sent") rank += 1;
  return rank;
}

/** The copy that stays visible. Ties go to the mailbox registered first, so the choice is stable between syncs. */
export function pickPrimary<T extends MessageCopy>(copies: T[]): T {
  return [...copies].sort(
    (a, b) =>
      copyRank(b) - copyRank(a) ||
      a.mailboxCreatedAt.getTime() - b.mailboxCreatedAt.getTime() ||
      a.mailboxId.localeCompare(b.mailboxId) ||
      a.id.localeCompare(b.id),
  )[0]!;
}

/**
 * Which copies of ONE email (same Message-ID) are duplicates, and of what.
 *  - Copies in the same direction as the primary are the same event seen from
 *    several mailboxes (everyone in To/Cc received it): one primary, the rest copies.
 *  - A colleague's outgoing email (primary = the sender's Sent Items copy) that
 *    landed in a mailbox that was only Cc'd is an informational copy → duplicate.
 *    If that mailbox was addressed directly (To) it is a real incoming request
 *    and stays visible; other cross-direction pairs are left alone.
 */
export function assignPrimaries<T extends MessageCopy>(copies: T[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (copies.length < 2) {
    for (const c of copies) out.set(c.id, null);
    return out;
  }
  const primary = pickPrimary(copies);
  for (const c of copies) {
    if (c.id === primary.id) out.set(c.id, null);
    else if (c.direction === primary.direction) out.set(c.id, primary.id);
    else if (c.direction === "inbound" && primary.direction === "outbound" && copyRank(c) < 20) out.set(c.id, primary.id);
    else out.set(c.id, null);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB wrappers

export interface ThreadRef {
  mailboxId: string;
  conversationId: string;
}

export const threadRefKey = (r: ThreadRef) => `${r.mailboxId}\u0000${r.conversationId}`;

const copySelect = {
  id: true,
  mailboxId: true,
  conversationId: true,
  internetMessageId: true,
  direction: true,
  folder: true,
  fromAddress: true,
  toAddresses: true,
  ccAddresses: true,
  duplicateOfId: true,
  mailbox: { select: { emailAddress: true, aliases: true, createdAt: true } },
} satisfies Prisma.MessageSelect;
type CopyRow = Prisma.MessageGetPayload<{ select: typeof copySelect }>;

function toCopy(r: CopyRow): MessageCopy & { conversationId: string; duplicateOfId: string | null } {
  return {
    id: r.id,
    mailboxId: r.mailboxId,
    conversationId: r.conversationId,
    duplicateOfId: r.duplicateOfId,
    direction: r.direction,
    folder: r.folder,
    fromAddress: r.fromAddress,
    toAddresses: r.toAddresses as unknown as RecipientLike[],
    ccAddresses: r.ccAddresses as unknown as RecipientLike[],
    owners: ownerAddresses(r.mailbox),
    mailboxCreatedAt: r.mailbox.createdAt,
  };
}

/**
 * Links every copy of the given emails (same Message-ID, any mailbox of the
 * company) to one primary row (see `assignPrimaries`). Rows whose
 * `duplicateOfId` changed are returned as thread references so the caller can
 * recompute them.
 */
export async function dedupeMessageIds(db: PrismaClient, orgId: string, internetMessageIds: string[]): Promise<{ changed: ThreadRef[]; duplicates: number }> {
  const ids = [...new Set(internetMessageIds.filter(Boolean))];
  const result = { changed: [] as ThreadRef[], duplicates: 0 };
  if (!ids.length) return result;
  const seen = new Set<string>();
  const touch = (r: ThreadRef) => {
    const k = threadRefKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      result.changed.push(r);
    }
  };
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.message.findMany({ where: { mailbox: { orgId }, internetMessageId: { in: ids.slice(i, i + 500) } }, select: copySelect });
    const groups = new Map<string, ReturnType<typeof toCopy>[]>();
    for (const r of rows) {
      const k = r.internetMessageId!;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(toCopy(r));
    }
    for (const copies of groups.values()) {
      const targets = assignPrimaries(copies);
      for (const c of copies) {
        const want = targets.get(c.id) ?? null;
        if (want) result.duplicates += 1;
        if (c.duplicateOfId === want) continue;
        await db.message.update({ where: { id: c.id }, data: { duplicateOfId: want } });
        touch({ mailboxId: c.mailboxId, conversationId: c.conversationId });
      }
    }
  }
  return result;
}

export interface DedupeOrgResult {
  messages: number;
  recipientsUpdated: number;
  groups: number;
  duplicates: number;
  linksChanged: number;
}

/**
 * Full pass over one company: refreshes `internalRecipients` on every message
 * and re-links every Message-ID that exists in more than one copy. Run after
 * the migration, after adding a mailbox, or when the company's domains change.
 * The caller recomputes the threads afterwards (`recomputeMailboxThreads`).
 */
export async function dedupeOrgMessages(db: PrismaClient, orgId: string, onProgress?: (done: number, total: number) => void): Promise<DedupeOrgResult> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId }, include: { mailboxes: { select: { id: true, emailAddress: true, aliases: true } } } });
  const domains = orgDomains(org);
  const ownersByMailbox = new Map(org.mailboxes.map((m) => [m.id, ownerAddresses(m)]));
  const out: DedupeOrgResult = { messages: 0, recipientsUpdated: 0, groups: 0, duplicates: 0, linksChanged: 0 };

  const total = await db.message.count({ where: { mailbox: { orgId } } });
  let cursor: string | undefined;
  for (;;) {
    const page = await db.message.findMany({
      where: { mailbox: { orgId } },
      select: { id: true, mailboxId: true, toAddresses: true, ccAddresses: true, internalRecipients: true },
      orderBy: { id: "asc" },
      take: 1000,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;
    for (const m of page) {
      const want = internalRecipients({ to: m.toAddresses as unknown as RecipientLike[], cc: m.ccAddresses as unknown as RecipientLike[] }, domains, ownersByMailbox.get(m.mailboxId) ?? new Set());
      if (!sameList(want, m.internalRecipients)) {
        await db.message.update({ where: { id: m.id }, data: { internalRecipients: want } });
        out.recipientsUpdated += 1;
      }
    }
    out.messages += page.length;
    onProgress?.(out.messages, total);
    cursor = page[page.length - 1]!.id;
    if (page.length < 1000) break;
  }

  const groups = await db.message.groupBy({
    by: ["internetMessageId"],
    where: { mailbox: { orgId }, internetMessageId: { not: null } },
    _count: { _all: true },
    having: { internetMessageId: { _count: { gt: 1 } } },
  });
  out.groups = groups.length;
  const r = await dedupeMessageIds(db, orgId, groups.map((g) => g.internetMessageId!));
  out.duplicates = r.duplicates;
  out.linksChanged = r.changed.length;
  // Rows still marked as copies whose primary no longer exists in a >1 group (e.g. after retention) are cleared too.
  const stale = await db.message.findMany({ where: { mailbox: { orgId }, duplicateOfId: { not: null }, internetMessageId: { notIn: groups.map((g) => g.internetMessageId!) } }, select: { id: true } });
  if (stale.length) {
    await db.message.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { duplicateOfId: null } });
    out.linksChanged += stale.length;
  }
  return out;
}
