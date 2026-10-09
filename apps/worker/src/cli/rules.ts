import { Command } from "commander";
import { DEFAULT_EXCLUSION_RULES, disconnectDb, getDb, reapplyExclusions, seedDefaultRules, type PrismaClient } from "@email-tracker/core";

const program = new Command().name("rules").description("Exclusion rules: default rules and re-applying rules to stored mail");

async function orgs(db: PrismaClient, key?: string) {
  const k = key?.toLowerCase();
  const found = await db.organization.findMany({ where: k ? { OR: [{ slug: k }, { domain: k }] } : {}, orderBy: { name: "asc" }, select: { id: true, name: true, slug: true } });
  if (!found.length) throw new Error(k ? `No company with slug or domain "${key}"` : "No companies in this database");
  return found;
}

async function reapply(db: PrismaClient, org: { id: string; name: string }) {
  const started = Date.now();
  const r = await reapplyExclusions(db, org.id, { onProgress: (done, total) => { if (done % 5000 === 0) console.log(`  ${org.name}: ${done}/${total} inbound emails checked`); } });
  console.log(`${org.name}: ${r.scanned} inbound emails checked, ${r.changed} changed, ${r.threadsRecomputed} threads recomputed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (r.failed.length) console.log(`  ${r.failed.length} thread(s) could not be recomputed; run this again or \`pnpm replies:recompute all\`. First error: ${r.failed[0]!.error}`);
}

program
  .command("seed-defaults")
  .description(`Add the ${DEFAULT_EXCLUSION_RULES.length} default rules (GoDaddy, Microsoft 365 notices, bounces) to every company that lacks them, then re-apply the rules. Safe to re-run: edited or deactivated defaults are left alone.`)
  .option("--org <slug>", "one company (slug or domain) instead of all")
  .option("--no-apply", "only create the rules; do not re-apply them to stored mail")
  .action(async (opts: { org?: string; apply: boolean }) => {
    const db = getDb();
    for (const org of await orgs(db, opts.org)) {
      console.log(`${org.name} (/c/${org.slug}): ${await seedDefaultRules(db, org.id)} default rule(s) added`);
      if (opts.apply) await reapply(db, org);
    }
  });

program
  .command("reapply")
  .description("Re-evaluate every stored inbound email against the company's current rules and settings, then recompute the affected threads (idempotent)")
  .option("--org <slug>", "one company (slug or domain) instead of all")
  .action(async (opts: { org?: string }) => {
    const db = getDb();
    for (const org of await orgs(db, opts.org)) await reapply(db, org);
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
