/**
 * Removes a company and everything stored under it: mailboxes, threads, emails,
 * exclusion rules, chats, AI usage, audit logs and memberships. Users keep their
 * accounts (an owner still sees the other companies). Nothing is touched in Microsoft 365.
 *   pnpm org:remove <slug|domain>          dry run: prints what would be deleted
 *   pnpm org:remove <slug|domain> --yes    deletes it
 * Live Graph subscriptions of its mailboxes are deleted first (best effort; they expire on their own otherwise).
 */
import { disconnectDb, getDb, GraphProvider } from "../src/index.js";

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith("--"))?.trim().toLowerCase();
const yes = args.includes("--yes");
if (!key) throw new Error("Usage: pnpm org:remove <slug|domain> [--yes]");

const db = getDb();
try {
  const org = await db.organization.findFirst({
    where: { OR: [{ slug: key }, { domain: key }] },
    include: {
      mailboxes: { orderBy: { emailAddress: "asc" }, select: { emailAddress: true, subscriptionId: true, _count: { select: { messages: true, threads: true } } } },
      _count: { select: { memberships: true, chatSessions: true, exclusionRules: true } },
    },
  });
  if (!org) throw new Error(`No company with slug or domain "${key}".`);
  const messages = org.mailboxes.reduce((n, m) => n + m._count.messages, 0);
  const threads = org.mailboxes.reduce((n, m) => n + m._count.threads, 0);
  console.log(`${org.name} (/c/${org.slug}, ${org.domain}): ${org.mailboxes.length} mailboxes, ${threads} threads, ${messages} emails, ${org._count.memberships} memberships, ${org._count.chatSessions} chats, ${org._count.exclusionRules} rules`);
  for (const m of org.mailboxes) console.log(`  ${m.emailAddress}: ${m._count.messages} emails, ${m._count.threads} threads${m.subscriptionId ? ", live Graph subscription" : ""}`);

  if (!yes) {
    console.log("\nDry run: nothing was deleted. Add --yes to remove this company and everything stored under it.");
  } else {
    const live = org.mailboxes.filter((m) => m.subscriptionId);
    if (live.length && org.azureTenantId) {
      try {
        const provider = new GraphProvider(org.azureTenantId);
        for (const m of live) {
          try {
            await provider.unsubscribe(m.subscriptionId!);
            console.log(`  Graph subscription of ${m.emailAddress} deleted`);
          } catch (err) {
            console.warn(`  could not delete the Graph subscription of ${m.emailAddress} (it expires on its own): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
          }
        }
      } catch (err) {
        console.warn(`  Graph subscriptions left to expire on their own: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
      }
    }
    await db.organization.delete({ where: { id: org.id } });
    console.log(`\nRemoved ${org.name} with ${messages} emails in ${threads} threads. Users keep their accounts.`);
  }
} finally {
  await disconnectDb();
}
