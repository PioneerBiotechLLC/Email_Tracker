import { Command } from "commander";
import { disconnectDb, getDb, recomputeMailboxThreads, type PrismaClient } from "@email-tracker/core";

const program = new Command().name("replies").description("Reply-tracking maintenance and reports");

async function targets(db: PrismaClient, email: string) {
  return email === "all"
    ? db.mailbox.findMany({ where: { isActive: true }, include: { org: true } })
    : [await db.mailbox.findUniqueOrThrow({ where: { emailAddress: email.toLowerCase() }, include: { org: true } })];
}

program
  .command("recompute")
  .description("Re-run reply detection and status for every thread of a mailbox (after backfill or rule changes)")
  .argument("<email>", "mailbox address or 'all'")
  .action(async (email: string) => {
    const db = getDb();
    for (const mb of await targets(db, email)) {
      const started = Date.now();
      const r = await recomputeMailboxThreads(db, mb.id, (done, total) => console.log(`  ${mb.emailAddress}: ${done}/${total} threads`));
      const by = Object.entries(r.byStatus).map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`${mb.emailAddress}: ${r.threads} threads, ${r.messagesUpdated} messages updated (${by}) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
  });

function fmtMinutes(min: number | null): string {
  if (min == null) return "-";
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = Math.round(min % 60);
  return [d ? `${d}d` : "", h ? `${h}h` : "", `${m}m`].filter(Boolean).join(" ");
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmtDate = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" }).format(d);

program
  .command("report")
  .description("Reply statistics for spot-checking against Outlook")
  .argument("<email>", "mailbox address")
  .option("--days <n>", "look-back window in days", (v: string) => Number(v), 30)
  .action(async (email: string, opts: { days: number }) => {
    const db = getDb();
    const [mb] = await targets(db, email);
    if (!mb) return;
    const since = new Date(Date.now() - opts.days * 86_400_000);
    const now = new Date();
    const owners = [mb.emailAddress, ...mb.aliases];
    const tz = mb.org.timezone;

    const inbound = await db.message.findMany({
      where: { mailboxId: mb.id, direction: "inbound", isAutoReply: false, fromAddress: { notIn: owners }, receivedAt: { gte: since } },
      select: { repliedAt: true, replyMethod: true, responseMinutes: true, responseBusinessMinutes: true },
    });
    const replied = inbound.filter((m) => m.repliedAt);
    const raw = replied.map((m) => m.responseMinutes!).filter((n) => n != null);
    const biz = replied.map((m) => m.responseBusinessMinutes!).filter((n) => n != null);
    const methods: Record<string, number> = {};
    for (const m of replied) methods[m.replyMethod ?? "?"] = (methods[m.replyMethod ?? "?"] ?? 0) + 1;

    const [awaiting, overdue] = await Promise.all([
      db.thread.count({ where: { mailboxId: mb.id, status: "awaiting_us" } }),
      db.thread.count({ where: { mailboxId: mb.id, status: "awaiting_us", overdueAt: { lte: now } } }),
    ]);
    const oldest = await db.message.findMany({
      where: { mailboxId: mb.id, direction: "inbound", isAutoReply: false, repliedAt: null, fromAddress: { notIn: owners }, thread: { status: "awaiting_us" } },
      orderBy: { receivedAt: "asc" },
      take: 10,
      select: { receivedAt: true, fromAddress: true, fromName: true, subject: true, thread: { select: { overdueAt: true } } },
    });

    const pct = inbound.length ? ((replied.length / inbound.length) * 100).toFixed(0) : "0";
    console.log(`\nReply report — ${mb.emailAddress} — last ${opts.days} days (times in ${tz})\n`);
    console.log(`  Inbound emails (real, non-auto):  ${inbound.length}`);
    console.log(`  Replied:                          ${replied.length} (${pct}%)  [${Object.entries(methods).map(([k, v]) => `${k}: ${v}`).join(", ") || "-"}]`);
    console.log(`  Response time, wall-clock:        median ${fmtMinutes(median(raw))}, average ${fmtMinutes(avg(raw))}`);
    console.log(`  Response time, business hours:    median ${fmtMinutes(median(biz))}, average ${fmtMinutes(avg(biz))}`);
    console.log(`  Threads awaiting our reply:       ${awaiting}`);
    console.log(`  …of which overdue:                ${overdue}`);
    console.log(`\n  Oldest unanswered emails:`);
    if (!oldest.length) console.log("    (none)");
    for (const m of oldest) {
      const flag = m.thread.overdueAt && m.thread.overdueAt <= now ? "OVERDUE" : "waiting";
      const from = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
      console.log(`    ${fmtDate(m.receivedAt, tz)}  ${flag.padEnd(7)}  ${from}\n      ${m.subject || "(no subject)"}`);
    }
    console.log();
  });

program
  .parseAsync(process.argv)
  .catch((err) => {
    console.error(err instanceof Error ? (process.env.LOG_LEVEL === "debug" ? err.stack : err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
