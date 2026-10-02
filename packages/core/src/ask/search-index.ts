/**
 * Full-text search index for the "Ask" chat: `Message.searchVector` and
 * `Thread.searchVector` (tsvector, GIN-indexed). The vectors are computed from
 * PLAINTEXT in app code at write time, because stored bodies may be encrypted.
 * Prisma cannot write tsvector columns, so vectors are written with one raw
 * UPDATE per batch (a sync page, a reindex chunk) instead of one per row.
 */
import { readBody } from "../crypto.js";
import { Prisma, type PrismaClient } from "../db.js";
import { searchText } from "./text.js";

interface Addressed {
  address: string;
}

interface MessageIndexInput {
  subject: string;
  fromName: string | null;
  fromAddress: string;
  to: Addressed[];
  cc: Addressed[];
  /** cleaned plaintext body, or null to index subject + participants only */
  body: string | null;
}

export function messageSearchText(m: MessageIndexInput): string {
  return searchText([m.subject, m.fromName, m.fromAddress, ...m.to.map((r) => r.address), ...m.cc.map((r) => r.address), m.body]);
}

/** Writes the search vectors of a batch of messages in one statement. `key` is the column the rows are identified by. */
export async function writeMessageVectors(db: PrismaClient, key: "id" | "graphMessageId", rows: { key: string; text: string }[]): Promise<void> {
  if (!rows.length) return;
  const column = Prisma.raw(`"${key}"`);
  await db.$executeRaw`
    UPDATE "Message" AS m SET "searchVector" = to_tsvector('simple', v.txt)
    FROM unnest(${rows.map((r) => r.key)}::text[], ${rows.map((r) => r.text)}::text[]) AS v(k, txt)
    WHERE m.${column} = v.k`;
}

/** Rebuilds the search vectors of threads from subject + AI summary + key points + next action. */
export async function writeThreadVectors(db: PrismaClient, threadIds: string[]): Promise<void> {
  if (!threadIds.length) return;
  const threads = await db.thread.findMany({ where: { id: { in: threadIds } }, select: { id: true, subject: true, summary: true, keyPoints: true, nextAction: true } });
  const texts = threads.map((t) => searchText([t.subject, t.summary, ...(Array.isArray(t.keyPoints) ? (t.keyPoints as string[]) : []), t.nextAction]));
  await db.$executeRaw`
    UPDATE "Thread" AS t SET "searchVector" = to_tsvector('simple', v.txt)
    FROM unnest(${threads.map((t) => t.id)}::text[], ${texts}::text[]) AS v(k, txt)
    WHERE t."id" = v.k`;
}

interface ReindexOptions {
  /** rebuild every row; default: only rows that have no vector yet, which makes an interrupted run resumable */
  all?: boolean;
  chunk?: number;
  onProgress?: (done: number, total: number, what: "messages" | "threads") => void;
}

interface ReindexResult {
  messages: number;
  threads: number;
}

/**
 * (Re)builds the search index of one company in chunks; each chunk is a single
 * UPDATE, so stopping midway loses nothing. Bodies are decrypted in memory only
 * and never logged. Honours the company's `searchIndexBodies` setting.
 */
export async function reindexOrg(db: PrismaClient, orgId: string, indexBodies: boolean, opts: ReindexOptions = {}): Promise<ReindexResult> {
  const chunk = opts.chunk ?? 500;
  const pending = opts.all ? Prisma.sql`TRUE` : Prisma.sql`x."searchVector" IS NULL`;
  const out: ReindexResult = { messages: 0, threads: 0 };

  for (const what of ["messages", "threads"] as const) {
    const table = Prisma.raw(what === "messages" ? `"Message"` : `"Thread"`);
    const [{ n }] = await db.$queryRaw<[{ n: bigint }]>`SELECT count(*) AS n FROM ${table} x JOIN "Mailbox" b ON b."id" = x."mailboxId" WHERE b."orgId" = ${orgId} AND ${pending}`;
    const total = Number(n);
    let cursor = "";
    for (;;) {
      const ids = (
        await db.$queryRaw<{ id: string }[]>`
          SELECT x."id" FROM ${table} x JOIN "Mailbox" b ON b."id" = x."mailboxId"
          WHERE b."orgId" = ${orgId} AND x."id" > ${cursor} AND ${pending} ORDER BY x."id" LIMIT ${chunk}`
      ).map((r) => r.id);
      if (!ids.length) break;
      if (what === "threads") await writeThreadVectors(db, ids);
      else {
        const rows = await db.message.findMany({ where: { id: { in: ids } }, select: { id: true, subject: true, fromName: true, fromAddress: true, toAddresses: true, ccAddresses: true, bodyText: true, bodyEncrypted: true, bodyPreview: true } });
        await writeMessageVectors(db, "id", rows.map((m) => ({
          key: m.id,
          text: messageSearchText({ subject: m.subject, fromName: m.fromName, fromAddress: m.fromAddress, to: m.toAddresses as unknown as Addressed[], cc: m.ccAddresses as unknown as Addressed[], body: indexBodies ? (readBody(m) ?? m.bodyPreview) : null }),
        })));
      }
      out[what] += ids.length;
      opts.onProgress?.(out[what], total, what);
      cursor = ids[ids.length - 1]!;
    }
  }
  return out;
}

interface SearchIndexSize {
  /** GIN indexes on Message + Thread */
  indexBytes: number;
  /** the tsvector column data itself */
  vectorBytes: number;
  messages: number;
}

/** Space used by the search index (shown in the storage indicator; Neon free = 0.5 GB). */
export async function searchIndexSize(db: PrismaClient): Promise<SearchIndexSize> {
  const [r] = await db.$queryRaw<[{ idx: bigint; vec: bigint; n: bigint }]>`
    SELECT pg_relation_size('"Message_searchVector_idx"'::regclass) + pg_relation_size('"Thread_searchVector_idx"'::regclass) AS idx,
           (SELECT COALESCE(sum(pg_column_size("searchVector")), 0) FROM "Message") + (SELECT COALESCE(sum(pg_column_size("searchVector")), 0) FROM "Thread") AS vec,
           (SELECT count(*) FROM "Message" WHERE "searchVector" IS NOT NULL) AS n`;
  return { indexBytes: Number(r.idx), vectorBytes: Number(r.vec), messages: Number(r.n) };
}
