import { Command } from "commander";
import { disconnectDb, getDb } from "@email-tracker/core";

const program = new Command().name("user").description("Dashboard users (who may sign in with Microsoft) and their company memberships");

program
  .command("add")
  .description("Add a user to a company (creates the user if needed), or make them an owner with --owner")
  .argument("<email>")
  .option("--org <domain>", "company domain (must exist, e.g. created by `pnpm mailbox add` or `pnpm org:seed`)")
  .option("--role <role>", "admin | viewer", "viewer")
  .option("--name <name>")
  .option("--owner", "global owner: sees and manages every company", false)
  .action(async (email: string, opts: { org?: string; role: string; name?: string; owner: boolean }) => {
    const db = getDb();
    const role = opts.role === "admin" ? "admin" : opts.role === "viewer" ? "viewer" : null;
    if (!role) throw new Error("--role must be admin or viewer");
    if (!opts.org && !opts.owner) throw new Error("Give --org <domain> (membership) and/or --owner");
    const u = await db.appUser.upsert({
      where: { email: email.toLowerCase() },
      create: { email: email.toLowerCase(), name: opts.name, isActive: true, isOwner: opts.owner },
      update: { isActive: true, ...(opts.name ? { name: opts.name } : {}), ...(opts.owner ? { isOwner: true } : {}) },
    });
    if (opts.org) {
      const org = await db.organization.findUnique({ where: { domain: opts.org.toLowerCase() } });
      if (!org) throw new Error(`No company with domain ${opts.org}. Run \`pnpm mailbox add <email>\` or \`pnpm org:seed\` first.`);
      await db.membership.upsert({ where: { userId_orgId: { userId: u.id, orgId: org.id } }, create: { userId: u.id, orgId: org.id, role }, update: { role } });
      console.log(`${u.email} → ${org.name} (${org.domain}) as ${role}${u.isOwner ? " · owner" : ""}.`);
    } else console.log(`${u.email} is now an owner (all companies).`);
    console.log("They can sign in with Microsoft now.");
  });

program.command("list").action(async () => {
  const rows = await getDb().appUser.findMany({ include: { memberships: { include: { org: true } } }, orderBy: { email: "asc" } });
  if (!rows.length) return console.log("No users. Add one with: pnpm user add <email> --org <domain> --role admin  (or --owner)");
  for (const u of rows) {
    const orgs = u.memberships.map((m) => `${m.org.slug}:${m.role}`).join(", ") || "-";
    console.log(`${u.isActive ? "●" : "○"} ${u.email.padEnd(40)} ${u.isOwner ? "OWNER " : "      "} ${orgs.padEnd(40)} lastLogin=${u.lastLoginAt?.toISOString() ?? "never"}`);
  }
});

program
  .command("remove")
  .description("Deactivate a user (row kept for audit history); with --org only removes that membership")
  .argument("<email>")
  .option("--org <domain>")
  .action(async (email: string, opts: { org?: string }) => {
    const db = getDb();
    const u = await db.appUser.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    if (opts.org) {
      const org = await db.organization.findUniqueOrThrow({ where: { domain: opts.org.toLowerCase() } });
      await db.membership.deleteMany({ where: { userId: u.id, orgId: org.id } });
      console.log(`Removed ${email} from ${org.name}`);
    } else {
      await db.appUser.update({ where: { id: u.id }, data: { isActive: false } });
      console.log(`Deactivated ${email}`);
    }
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
