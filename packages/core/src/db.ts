import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";
import { getEnv } from "./env.js";

let client: PrismaClient | null = null;

/** Shared Prisma client (Postgres via the pg driver adapter). */
export function getDb(): PrismaClient {
  if (client) return client;
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  client = new PrismaClient({ adapter });
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

export type { PrismaClient };
export * from "./generated/prisma/client.js";
