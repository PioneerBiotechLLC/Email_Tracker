import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { getEnv } from "./env.js";

// Process-wide singleton (survives Next.js dev-server module re-evaluation).
const g = globalThis as unknown as { __emailTrackerDb?: PrismaClient };

function poolOptions(url: string) {
  // Honour Prisma-style `connection_limit` / `pool_timeout` in the URL so hosted
  // Postgres (Supabase/Neon poolers) and the local `prisma dev` server behave.
  // Serverless (Vercel) functions each hold their own pool: keep it small so many
  // concurrent instances stay under Neon's connection cap (the pooled URL helps too).
  let max = process.env.VERCEL ? 3 : 10;
  let idleTimeoutMillis = process.env.VERCEL ? 10_000 : 30_000;
  try {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("connection_limit"));
    if (Number.isFinite(limit) && limit > 0) max = limit;
    const idle = Number(u.searchParams.get("max_idle_connection_lifetime"));
    if (Number.isFinite(idle) && idle > 0) idleTimeoutMillis = idle * 1000;
  } catch {
    /* keep defaults */
  }
  return { max, idleTimeoutMillis };
}

/** Shared Prisma client (Postgres via the pg driver adapter). */
export function getDb(): PrismaClient {
  if (g.__emailTrackerDb) return g.__emailTrackerDb;
  const url = getEnv().DATABASE_URL;
  const adapter = new PrismaPg({ connectionString: url, ...poolOptions(url) });
  g.__emailTrackerDb = new PrismaClient({ adapter });
  return g.__emailTrackerDb;
}

export async function disconnectDb(): Promise<void> {
  if (g.__emailTrackerDb) {
    await g.__emailTrackerDb.$disconnect();
    g.__emailTrackerDb = undefined;
  }
}

export type { PrismaClient };
export * from "./generated/prisma/client.js";
