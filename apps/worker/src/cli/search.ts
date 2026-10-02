import { Command } from "commander";
import { backfillWebLinks, disconnectDb, formatBytes, getDb, orgSettings, reindexOrg, searchIndexSize, type PrismaClient } from "@email-tracker/core";

const program = new Command().name("search-index").description("Search index for the Ask chat: build / rebuild it, and fetch Outlook links for old mail");

async function orgs(db: PrismaClient, key?: string) {
  const k = key?.toLowerCase();
  const found = await db.organization.findMany({ where: k ? { OR: [{ slug: k }, { domain: k }] } : {}, orderBy: { name: "asc" }, select: { id: true, name: true, settings: true, azureTenantId: true, isDemo: true } });
  if (!found.length) throw new Error(k ? `No company with slug or domain "${key}"` : "No companies in this database");
  return found;
}

program
  .command("reindex")
  .description("Build the search index for stored emails and threads, 500 rows per statement. Safe to stop and re-run: by default only rows without an index entry are processed.")
  .option("--org <slug>", "one company (slug or domain) instead of all")
  .option("--all", "rebuild every row (e.g. after changing the company's 'index email bodies' setting)", false)
  .action(async (opts: { org?: string; all: boolean }) => {
    const db = getDb();
    for (const org of await orgs(db, opts.org)) {
      const started = Date.now();
      const bodies = orgSettings(org.settings).searchIndexBodies;
      const r = await reindexOrg(db, org.id, bodies, { all: opts.all, onProgress: (done, total, what) => console.log(`  ${org.name}: ${done}/${total} ${what}`) });
      console.log(`${org.name}: ${r.messages} emails and ${r.threads} threads indexed (${bodies ? "subject, participants and body" : "subject and participants only"}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const size = await searchIndexSize(db);
    console.log(`Search index: ${formatBytes(size.vectorBytes)} of vectors + ${formatBytes(size.indexBytes)} of GIN indexes for ${size.messages} emails${size.messages >= 1000 ? ` (${formatBytes(Math.round(((size.vectorBytes + size.indexBytes) / size.messages) * 10_000))} per 10,000 emails at this average)` : ""}`);
  });

program
  .command("backfill-links")
  .description("Fetch the \"Open in Outlook\" link for emails synced before links were stored (read-only Graph $batch GETs, 20 per request). Resumable: re-run to continue.")
  .option("--org <slug>", "one company (slug or domain) instead of all")
  .action(async (opts: { org?: string }) => {
    const db = getDb();
    for (const org of await orgs(db, opts.org)) {
      if (!org.azureTenantId) {
        console.log(`${org.name}: skipped (${org.isDemo ? "demo data" : "not connected to Microsoft 365"})`);
        continue;
      }
      const r = await backfillWebLinks(db, org.id, { onProgress: (mailbox, done, total) => console.log(`  ${mailbox}: ${done}/${total}`) });
      console.log(`${org.name}: ${r.linked} links stored, ${r.gone} emails no longer in the mailbox, ${r.failed} lookups failed${r.failed ? " (re-run to retry them)" : ""}`);
    }
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
