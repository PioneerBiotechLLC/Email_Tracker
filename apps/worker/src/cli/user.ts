import { Command } from "commander";
import { disconnectDb, getDb } from "@email-tracker/core";

const program = new Command().name("user").description("Dashboard users (who may sign in with Microsoft)");

program
  .command("add")
  .argument("<email>")
  .requiredOption("--org <domain>", "organization domain (must exist, e.g. created by `pnpm mailbox add`)")
  .option("--role <role>", "admin | viewer", "viewer")
  .option("--name <name>")
  .action(async (email: string, opts: { org: string; role: string; name?: string }) => {
    const db = getDb();
    const role = opts.role === "admin" ? "admin" : opts.role === "viewer" ? "viewer" : null;
    if (!role) throw new Error("--role must be admin or viewer");
    const org = await db.organization.findUnique({ where: { domain: opts.org.toLowerCase() } });
    if (!org) throw new Error(`No organization with domain ${opts.org}. Run \`pnpm mailbox add <email>\` first.`);
    const u = await db.appUser.upsert({
      where: { email: email.toLowerCase() },
      create: { orgId: org.id, email: email.toLowerCase(), role, name: opts.name, isActive: true },
      update: { orgId: org.id, role, isActive: true, ...(opts.name ? { name: opts.name } : {}) },
    });
    console.log(`${u.email} → ${org.domain} as ${u.role} (active). They can now sign in with Microsoft.`);
  });

program.command("list").action(async () => {
  const rows = await getDb().appUser.findMany({ include: { org: true }, orderBy: [{ org: { domain: "asc" } }, { email: "asc" }] });
  if (!rows.length) return console.log("No users. Add one with: pnpm user add <email> --org <domain> --role admin");
  for (const u of rows) console.log(`${u.isActive ? "●" : "○"} ${u.email.padEnd(40)} ${u.role.padEnd(7)} org=${u.org.domain.padEnd(24)} lastLogin=${u.lastLoginAt?.toISOString() ?? "never"}`);
});

program
  .command("remove")
  .description("Deactivate a user (the row is kept for audit history)")
  .argument("<email>")
  .action(async (email: string) => {
    await getDb().appUser.update({ where: { email: email.toLowerCase() }, data: { isActive: false } });
    console.log(`Deactivated ${email}`);
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
