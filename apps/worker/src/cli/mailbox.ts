import { Command } from "commander";
import { GraphProvider, disconnectDb, ensureSubscription, getDb, getEnv, seedDefaultRules, slugify } from "@email-tracker/core";

const program = new Command().name("mailbox").description("Register and manage tracked mailboxes");

program
  .command("add")
  .argument("<email>", "mailbox address, e.g. sales@api-pharma.net")
  .option("--org-domain <domain>", "organization domain (default: the email's domain)")
  .option("--org-name <name>", "organization name when creating a new org")
  .option("--tenant <id>", "Azure tenant id for this org (default: AZURE_TENANT_ID)")
  .option("--timezone <tz>", "org timezone when creating a new org", "Asia/Dubai")
  .option("--alias <address...>", "extra addresses that count as this mailbox (proxy addresses are auto-added)")
  .action(async (email: string, opts) => {
    const env = getEnv();
    const db = getDb();
    const address = email.trim().toLowerCase();
    const domain = (opts.orgDomain ?? address.split("@")[1] ?? "").toLowerCase();
    if (!domain) throw new Error("Could not determine the organization domain");

    const tenantId = opts.tenant ?? env.AZURE_TENANT_ID ?? null;
    let org = await db.organization.findUnique({ where: { domain } });
    if (!org) {
      org = await db.organization.create({
        data: { name: opts.orgName ?? domain, slug: slugify(opts.orgName ?? domain.split(".")[0]!), domain, azureTenantId: tenantId, consentGrantedAt: tenantId ? new Date() : null, timezone: opts.timezone },
      });
      await seedDefaultRules(db, org.id);
    } else if (!org.azureTenantId && tenantId) {
      org = await db.organization.update({ where: { id: org.id }, data: { azureTenantId: tenantId, consentGrantedAt: new Date() } });
    }
    if (!org.azureTenantId) throw new Error(`Company ${org.name} has no Microsoft 365 tenant yet. Pass --tenant <id> or connect it in the dashboard (Companies → Connect Microsoft 365).`);
    console.log(`Company: ${org.name} (/c/${org.slug}, ${org.domain}) tenant=${org.azureTenantId}`);

    const provider = new GraphProvider(org.azureTenantId);
    const user = await provider.resolveUser(address);
    const aliases = Array.from(
      new Set(
        [...(opts.alias ?? []), ...user.proxyAddresses, user.mail ?? "", user.userPrincipalName]
          .map((a: string) => a.trim().toLowerCase())
          .filter((a: string) => a && a !== address),
      ),
    );

    const mailbox = await db.mailbox.upsert({
      where: { emailAddress: address },
      create: {
        orgId: org.id,
        emailAddress: address,
        displayName: user.displayName,
        graphUserId: user.id,
        aliases,
        isActive: true,
      },
      update: { displayName: user.displayName, graphUserId: user.id, aliases, isActive: true },
    });
    console.log(`Mailbox ready: ${mailbox.emailAddress} (${mailbox.displayName ?? "no name"})`);
    console.log(`  graphUserId: ${mailbox.graphUserId}`);
    if (aliases.length) console.log(`  aliases: ${aliases.join(", ")}`);
    const sub = await ensureSubscription(db, mailbox.id);
    console.log(sub.action === "skipped" ? `  live notifications: skipped (${sub.detail})` : sub.action === "error" ? `  live notifications: FAILED (${sub.detail})` : `  live notifications: subscription ${sub.action}, expires ${sub.expiresAt?.toISOString()}`);
    console.log(`\nNext: pnpm sync:once ${mailbox.emailAddress}`);
  });

program.command("list").action(async () => {
  const rows = await getDb().mailbox.findMany({ include: { org: true, _count: { select: { messages: true, threads: true } } } });
  if (!rows.length) return console.log("No mailboxes registered. Use: pnpm mailbox add <email>");
  for (const m of rows) {
    console.log(
      `${m.isActive ? "●" : "○"} ${m.emailAddress.padEnd(40)} org=${m.org.domain.padEnd(20)} ` +
        `messages=${String(m._count.messages).padStart(6)} threads=${String(m._count.threads).padStart(5)} ` +
        `lastSync=${m.lastSyncedAt?.toISOString() ?? "never"}`,
    );
  }
});

program
  .command("pause")
  .argument("<email>")
  .action(async (email: string) => {
    await getDb().mailbox.update({ where: { emailAddress: email.toLowerCase() }, data: { isActive: false } });
    console.log(`Paused ${email}`);
  });

program
  .command("resume")
  .argument("<email>")
  .action(async (email: string) => {
    await getDb().mailbox.update({ where: { emailAddress: email.toLowerCase() }, data: { isActive: true } });
    console.log(`Resumed ${email}`);
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
