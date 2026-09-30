import type { PrismaClient } from "../db.js";
import { getEnv } from "../env.js";
import { getGraphAccessToken } from "../graph/auth.js";

export interface HealthReport {
  ok: boolean;
  time: string;
  db: { ok: boolean; latencyMs: number | null; error?: string };
  companies: {
    slug: string;
    consented: boolean;
    graphToken: "ok" | "failed" | "skipped";
    mailboxes: number;
    activeMailboxes: number;
    oldestSyncAgeMinutes: number | null;
    subscriptionsExpiringSoon: number;
    lastSyncError: boolean;
  }[];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Health without secrets: DB reachability, per-company Graph token check and sync freshness. */
export async function healthReport(db: PrismaClient, opts: { checkGraph?: boolean; now?: Date } = {}): Promise<HealthReport> {
  const now = opts.now ?? new Date();
  const report: HealthReport = { ok: true, time: now.toISOString(), db: { ok: false, latencyMs: null }, companies: [] };
  const started = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    report.db = { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    report.db = { ok: false, latencyMs: null, error: err instanceof Error ? err.message.slice(0, 120) : "db error" };
    report.ok = false;
    return report;
  }
  const env = getEnv();
  const graphConfigured = !!(env.AZURE_CLIENT_ID && env.AZURE_CLIENT_SECRET);
  const orgs = await db.organization.findMany({ where: { isDemo: false }, include: { mailboxes: { select: { isActive: true, lastSyncedAt: true, lastSyncError: true, subscriptionExpiresAt: true } } } });
  for (const org of orgs) {
    const active = org.mailboxes.filter((m) => m.isActive);
    const ages = active.map((m) => (m.lastSyncedAt ? (now.getTime() - m.lastSyncedAt.getTime()) / 60_000 : Infinity));
    const oldest = ages.length ? Math.max(...ages) : null;
    let graphToken: "ok" | "failed" | "skipped" = "skipped";
    if (opts.checkGraph && graphConfigured && org.azureTenantId) {
      try { await withTimeout(getGraphAccessToken(org.azureTenantId), 8000); graphToken = "ok"; } catch { graphToken = "failed"; report.ok = false; }
    }
    const c = {
      slug: org.slug,
      consented: !!org.azureTenantId && !!org.consentGrantedAt,
      graphToken,
      mailboxes: org.mailboxes.length,
      activeMailboxes: active.length,
      oldestSyncAgeMinutes: oldest == null ? null : oldest === Infinity ? null : Math.round(oldest),
      subscriptionsExpiringSoon: active.filter((m) => !m.subscriptionExpiresAt || m.subscriptionExpiresAt.getTime() - now.getTime() < 24 * 3_600_000).length,
      lastSyncError: active.some((m) => !!m.lastSyncError),
    };
    if (active.length && (c.oldestSyncAgeMinutes == null || c.oldestSyncAgeMinutes > 60 || c.lastSyncError)) report.ok = false;
    report.companies.push(c);
  }
  return report;
}
