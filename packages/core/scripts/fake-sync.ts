/**
 * Local integration check for the sync engine using a fake MailProvider
 * (no Graph credentials needed). Run against any Postgres:
 *   DATABASE_URL=... AZURE_TENANT_ID=t AZURE_CLIENT_ID=c AZURE_CLIENT_SECRET=s pnpm exec tsx scripts/fake-sync.ts
 */
import { getDb, disconnectDb, syncMailbox, readBody } from "../src/index.js";
import type { MailProvider, RawMessage, ListChangesOptions, DeltaPage, ListChangesResult, SubscriptionInfo, MailUser } from "../src/mail/provider.js";

const OWNER = "sales@example-pharma.com";
const d = (s: string) => new Date(s);

function msg(p: Partial<RawMessage> & { id: string; receivedAt: Date; subject: string }): RawMessage {
  return {
    changeKey: null, conversationId: "conv-1", internetMessageId: `<${p.id}@x>`, from: { address: "ali@customer.com", name: "Ali" },
    to: [{ address: OWNER, name: "Sales" }], cc: [], sentAt: p.receivedAt, bodyPreview: p.subject, body: { contentType: "text", content: "hello" },
    hasAttachments: false, importance: "normal", isDraft: false, headers: null, lastVerb: null, lastVerbAt: null, ...p,
  };
}

const inbox: RawMessage[] = [
  msg({ id: "m1", subject: "PO 4512 – Paracetamol", receivedAt: d("2026-09-01T08:00:00Z"),
    body: { contentType: "html", content: "<p>Please quote 500 units.</p><br>Best regards,<br>Ali" }, lastVerb: 102, lastVerbAt: d("2026-09-01T10:00:00Z") }),
  msg({ id: "m3", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-02T09:00:00Z"),
    body: { contentType: "text", content: "Thanks, confirmed.\n\nOn Mon, Sales wrote:\n> Quote attached" },
    headers: [{ name: "In-Reply-To", value: "<m2@x>" }, { name: "References", value: "<m1@x> <m2@x>" }] }),
  msg({ id: "m4", subject: "Automatic reply: Newsletter", conversationId: "conv-2", receivedAt: d("2026-09-03T09:00:00Z"),
    headers: [{ name: "Auto-Submitted", value: "auto-replied" }] }),
  msg({ id: "draft", subject: "draft", receivedAt: d("2026-09-03T09:00:00Z"), isDraft: true }),
];
const sent: RawMessage[] = [
  msg({ id: "m2", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-01T10:00:00Z"), from: { address: OWNER, name: "Sales" },
    to: [{ address: "ali@customer.com", name: "Ali" }], headers: [{ name: "In-Reply-To", value: "<m1@x>" }] }),
];

class FakeProvider implements MailProvider {
  calls = 0;
  async resolveUser(): Promise<MailUser> { return { id: "u1", displayName: "Sales", mail: OWNER, userPrincipalName: OWNER, proxyAddresses: [] }; }
  async *listChanges(opts: ListChangesOptions): AsyncGenerator<DeltaPage, ListChangesResult, void> {
    this.calls++;
    if (opts.deltaLink) { yield { messages: [], removedIds: [] }; return { deltaLink: opts.deltaLink }; }
    const all = opts.folder === "inbox" ? inbox : sent;
    yield { messages: all.slice(0, 2), removedIds: [] };
    if (opts.onProgress) await opts.onProgress(`next:${opts.folder}`);
    yield { messages: all.slice(2), removedIds: ["gone"] };
    return { deltaLink: `delta:${opts.folder}` };
  }
  async getMessages(): Promise<RawMessage[]> { return []; }
  async subscribe(): Promise<SubscriptionInfo> { throw new Error("n/a"); }
  async renew(): Promise<SubscriptionInfo> { throw new Error("n/a"); }
}

function assert(cond: unknown, label: string) { if (!cond) throw new Error(`ASSERT FAILED: ${label}`); console.log(`  ✓ ${label}`); }

const db = getDb();
try {
  await db.organization.deleteMany({ where: { domain: "example-pharma.com" } });
  const org = await db.organization.create({ data: { name: "Example", domain: "example-pharma.com", azureTenantId: "t" } });
  const mb = await db.mailbox.create({ data: { orgId: org.id, emailAddress: OWNER, graphUserId: "u1" } });
  const provider = new FakeProvider();

  console.log("first sync (backfill)");
  const s1 = await syncMailbox(mb.id, { provider });
  assert(s1.folders.inbox.upserted === 3 && s1.folders.inbox.skippedDrafts === 1, "inbox: 3 upserted, 1 draft skipped");
  assert(s1.folders.sentitems.upserted === 1, "sent: 1 upserted");
  assert(s1.threadsRecomputed === 2, "2 threads recomputed");

  const m1 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m1" } });
  assert(m1.direction === "inbound" && m1.lastVerb === 102, "m1 inbound with reply verb");
  assert(readBody(m1) === "Please quote 500 units.", `m1 body cleaned (got ${JSON.stringify(readBody(m1))})`);
  const m2 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m2" } });
  assert(m2.direction === "outbound" && m2.folder === "sent" && m2.inReplyTo === "<m1@x>", "m2 outbound with In-Reply-To");
  const m3 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m3" } });
  assert(readBody(m3) === "Thanks, confirmed.", `m3 quoted history stripped (got ${JSON.stringify(readBody(m3))})`);
  assert(m3.references.length === 2, "m3 references parsed");
  const m4 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m4" } });
  assert(m4.isAutoReply, "m4 flagged auto-reply");

  const t1 = await db.thread.findUniqueOrThrow({ where: { mailboxId_conversationId: { mailboxId: mb.id, conversationId: "conv-1" } } });
  assert(t1.messageCount === 3 && t1.normalizedSubject === "po 4512 – paracetamol", `thread grouped: ${t1.messageCount} msgs, "${t1.normalizedSubject}"`);
  assert(t1.status === "awaiting_us" && (t1.participants as unknown[]).length === 2, "thread status/participants");
  assert(t1.firstMessageAt.toISOString() === "2026-09-01T08:00:00.000Z" && t1.lastMessageAt.toISOString() === "2026-09-02T09:00:00.000Z", "thread time range");

  const mbAfter = await db.mailbox.findUniqueOrThrow({ where: { id: mb.id } });
  assert(mbAfter.inboxDeltaLink === "delta:inbox" && mbAfter.sentDeltaLink === "delta:sentitems" && mbAfter.lastSyncedAt, "delta links + lastSyncedAt saved");

  console.log("second sync (incremental, idempotent)");
  const s2 = await syncMailbox(mb.id, { provider });
  assert(s2.folders.inbox.upserted === 0, "incremental pulled nothing new");
  assert((await db.message.count({ where: { mailboxId: mb.id } })) === 4, "no duplicates");

  console.log("reset sync");
  const s3 = await syncMailbox(mb.id, { provider, reset: true });
  assert(s3.folders.inbox.upserted === 3 && (await db.message.count({ where: { mailboxId: mb.id } })) === 4, "reset re-upserts without duplicates");

  await db.organization.deleteMany({ where: { domain: "example-pharma.com" } });
  console.log("\nALL CHECKS PASSED");
} finally {
  await disconnectDb();
}
