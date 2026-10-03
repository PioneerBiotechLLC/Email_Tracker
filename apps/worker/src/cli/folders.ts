import { Command } from "commander";
import { GraphProvider, disconnectDb, getDb, getEnv, importSentFolders, looksLikeSentFolder, type MailboxFolder, type PrismaClient } from "@email-tracker/core";

const program = new Command()
  .name("folders")
  .description("Mail folders outside Inbox / Sent Items, e.g. the old provider's sent folder after a Zoho → Microsoft 365 migration (read-only)");

async function targets(db: PrismaClient, email: string, org?: string) {
  const o = org?.toLowerCase();
  const mailboxes =
    email === "all"
      ? await db.mailbox.findMany({ where: { isActive: true, ...(o ? { org: { OR: [{ slug: o }, { domain: o }] } } : {}) }, include: { org: true }, orderBy: { emailAddress: "asc" } })
      : [await db.mailbox.findUniqueOrThrow({ where: { emailAddress: email.toLowerCase() }, include: { org: true } })];
  if (!mailboxes.length) throw new Error("No matching active mailboxes");
  for (const mb of mailboxes) if (!mb.org.azureTenantId) throw new Error(`${mb.emailAddress}: company ${mb.org.name} is not connected to Microsoft 365`);
  return mailboxes;
}

/** Folders to import: the ones named with --folder (path or name, case-insensitive), otherwise every folder whose name says "sent". */
function pick(folders: MailboxFolder[], names: string[] | undefined): MailboxFolder[] {
  const wanted = names?.map((n) => n.trim().toLowerCase());
  return folders.filter((f) => !f.isSentItems && (wanted ? wanted.includes(f.path.toLowerCase()) || wanted.includes(f.displayName.toLowerCase()) : looksLikeSentFolder(f.displayName)));
}

program
  .command("list")
  .description("List every mail folder of the mailbox(es) with item counts, marking the ones `folders:import` would load as sent mail")
  .argument("<email>", "mailbox address or 'all'")
  .option("--org <slug>", "with 'all': one company (slug or domain)")
  .action(async (email: string, opts: { org?: string }) => {
    const db = getDb();
    for (const mb of await targets(db, email, opts.org)) {
      const folders = await new GraphProvider(mb.org.azureTenantId!).listMailFolders(mb.graphUserId);
      const chosen = new Set(pick(folders, undefined).map((f) => f.id));
      console.log(`\n${mb.emailAddress}`);
      for (const f of folders) {
        const mark = f.isSentItems ? "  (Sent Items: already synced)" : chosen.has(f.id) ? "  <- will import as sent mail" : "";
        console.log(`  ${f.path.padEnd(40)} ${String(f.totalItemCount).padStart(7)} items${mark}`);
      }
    }
  });

program
  .command("import")
  .description("Load the last N days of the mailbox's extra sent folders as sent mail, so replies in them count. Safe to re-run.")
  .argument("<email>", "mailbox address or 'all'")
  .option("--org <slug>", "with 'all': one company (slug or domain)")
  .option("--folder <names...>", "import these folders (name or path such as \"Inbox/Sent\") instead of the ones detected by name")
  .option("--days <n>", "how far back, by sent date (default: BACKFILL_DAYS)", (v: string) => Number(v))
  .option("--dry-run", "only show which folders would be imported", false)
  .action(async (email: string, opts: { org?: string; folder?: string[]; days?: number; dryRun: boolean }) => {
    const db = getDb();
    const days = opts.days ?? getEnv().BACKFILL_DAYS;
    for (const mb of await targets(db, email, opts.org)) {
      const provider = new GraphProvider(mb.org.azureTenantId!);
      const folders = pick(await provider.listMailFolders(mb.graphUserId), opts.folder);
      if (!folders.length) {
        console.log(`${mb.emailAddress}: no extra sent folder found${opts.folder ? ` named ${opts.folder.join(", ")}` : ""}`);
        continue;
      }
      const names = folders.map((f) => `"${f.path}" (${f.totalItemCount} items in total)`).join(", ");
      if (opts.dryRun) {
        console.log(`${mb.emailAddress}: would import ${names}, last ${days} days`);
        continue;
      }
      const r = await importSentFolders(mb.id, folders, { sinceDays: days, provider });
      console.log(`\n${mb.emailAddress}`);
      for (const f of r.folders) console.log(`  ${f.path}: ${f.upserted} emails from the last ${days} days stored as sent mail${f.skippedDrafts ? `, ${f.skippedDrafts} drafts skipped` : ""}`);
      console.log(`  threads recomputed: ${r.threadsRecomputed}${r.siblingThreadsRecomputed ? ` (+${r.siblingThreadsRecomputed} in other mailboxes of the company)` : ""}`);
      if (r.duplicates) console.log(`  copies of emails already tracked in another mailbox: ${r.duplicates}`);
      console.log(`  took ${(r.durationMs / 1000).toFixed(1)}s`);
    }
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    if (err instanceof Error && err.cause) console.error("Cause:", err.cause instanceof Error ? err.cause.message : err.cause);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
