/**
 * Verifies the AppUser → Membership migration keeps every user, by replaying all
 * migrations up to the previous one inside a scratch schema, inserting users,
 * then applying the multi-company migration and checking the result.
 *   DATABASE_URL=... pnpm exec tsx scripts/check-migration.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadDotenv } from "../src/dotenv.js";

loadDotenv();
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "../prisma/migrations");
const all = readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort();
const target = "20260930090000_multi_company";
const before = all.filter((d) => d < target);
const SCHEMA = "mig_check";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
function assert(c: unknown, label: string) { if (!c) throw new Error(`ASSERT FAILED: ${label}`); console.log(`  ✓ ${label}`); }
try {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; SET search_path TO ${SCHEMA};`);
  for (const m of before) await client.query(readFileSync(join(dir, m, "migration.sql"), "utf8").replace(/CREATE SCHEMA IF NOT EXISTS "public";/g, ""));
  await client.query(`INSERT INTO "Organization" ("id","name","domain","azureTenantId") VALUES ('o1','API Pharma','api-pharma.net','t1'), ('o2','Api Pharma Two','api-pharma.com','t2')`);
  await client.query(`INSERT INTO "AppUser" ("id","orgId","email","role","isActive") VALUES ('u1','o1','a@x.com','admin',true), ('u2','o1','v@x.com','viewer',true), ('u3','o2','w@y.com','admin',false)`);
  await client.query(readFileSync(join(dir, target, "migration.sql"), "utf8"));
  const mem = await client.query(`SELECT "userId","orgId","role" FROM "Membership" ORDER BY "userId"`);
  assert(mem.rowCount === 3, "3 memberships created for 3 users");
  assert(mem.rows.every((r) => (r.userId === "u1" && r.orgId === "o1" && r.role === "admin") || (r.userId === "u2" && r.orgId === "o1" && r.role === "viewer") || (r.userId === "u3" && r.orgId === "o2" && r.role === "admin")), "memberships keep org and role");
  const users = await client.query(`SELECT "id","isOwner","isActive" FROM "AppUser" ORDER BY "id"`);
  assert(users.rowCount === 3 && users.rows.every((r) => r.isOwner === false), "all users kept, none became owner");
  assert(users.rows.find((r) => r.id === "u3")?.isActive === false, "inactive flag preserved");
  const orgs = await client.query(`SELECT "id","slug","consentGrantedAt" FROM "Organization" ORDER BY "id"`);
  assert(orgs.rows[0]?.slug === "api-pharma" && orgs.rows[1]?.slug === "api-pharma-2", `slugs backfilled and de-duplicated (${orgs.rows.map((r) => r.slug).join(", ")})`);
  assert(orgs.rows.every((r) => r.consentGrantedAt != null), "existing tenants marked as consented");
  const cols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'AppUser'`, [SCHEMA]);
  assert(!cols.rows.some((r) => r.column_name === "orgId" || r.column_name === "role"), "AppUser.orgId/role dropped");
  console.log("MIGRATION CHECK PASSED");
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await client.end();
}
