import { searchIndexSize } from "../ask/search-index.js";
import type { PrismaClient } from "../db.js";

export interface StorageInfo {
  bytes: number;
  limitBytes: number;
  pct: number;
  warn: boolean;
  /** part of `bytes` used by the email search index (tsvector columns + their GIN indexes) */
  searchIndexBytes: number;
}

/** Database size vs the plan limit (Neon free = 512 MB). Warns at 80%. */
export async function databaseStorage(db: PrismaClient, limitMb = 512): Promise<StorageInfo> {
  const rows = await db.$queryRaw<{ size: bigint | number }[]>`SELECT pg_database_size(current_database()) AS size`;
  const bytes = Number(rows[0]?.size ?? 0);
  const limitBytes = limitMb * 1024 * 1024;
  const pct = limitBytes ? Math.round((bytes / limitBytes) * 1000) / 10 : 0;
  const search = await searchIndexSize(db);
  return { bytes, limitBytes, pct, warn: pct >= 80, searchIndexBytes: search.indexBytes + search.vectorBytes };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
