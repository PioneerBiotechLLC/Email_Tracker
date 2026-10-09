/**
 * Local integration check for the sync engine using a fake MailProvider
 * (no Graph credentials needed). Run against any Postgres:
 *   DATABASE_URL=... AZURE_TENANT_ID=t AZURE_CLIENT_ID=c AZURE_CLIENT_SECRET=s pnpm exec tsx scripts/fake-sync.ts
 */
import { getDb, disconnectDb, syncMailbox, importSentFolders, relinkRecentCopies, readBody, recomputeThread, summarizeThread, summarizeThreads, planBackfill, summarizePeriod, latestPeriodSummary, mailboxScope, seedDefaultRules, reapplyExclusions, countRuleMatches, collectPeriodActivity, SUMMARY_TOOL_NAME, PERIOD_SUMMARY_TOOL_NAME, type SummaryClient } from "../src/index.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { MailProvider, MailboxFolder, RawMessage, ListChangesOptions, DeltaPage, ListChangesResult, SubscriptionInfo, MailUser } from "../src/mail/provider.js";

const OWNER = "sales@example-pharma.com";
const REG = "regulatory@example-pharma.com";
const d = (s: string) => new Date(s);

function msg(p: Partial<RawMessage> & { id: string; receivedAt: Date; subject: string }): RawMessage {
  return {
    changeKey: null, conversationId: "conv-1", internetMessageId: `<${p.id}@x>`, from: { address: "ali@customer.com", name: "Ali" },
    to: [{ address: OWNER, name: "Sales" }], cc: [], sentAt: p.receivedAt, bodyPreview: p.subject, body: { contentType: "text", content: "hello" },
    hasAttachments: false, importance: "normal", isDraft: false, headers: null, lastVerb: null, lastVerbAt: null, inferenceClassification: null, webLink: null, ...p,
  };
}

const inbox: RawMessage[] = [
  msg({ id: "m1", subject: "PO 4512 – Paracetamol", receivedAt: d("2026-09-01T08:00:00Z"), cc: [{ address: REG, name: "Regulatory" }], webLink: "https://outlook.office365.com/owa/?ItemID=m1",
    body: { contentType: "html", content: "<p>Please quote 500 units.</p><br>Best regards,<br>Ali" }, lastVerb: 102, lastVerbAt: d("2026-09-01T10:05:00Z") }),
  msg({ id: "m3", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-02T09:00:00Z"),
    body: { contentType: "text", content: "Thanks, confirmed.\n\nOn Mon, Sales wrote:\n> Quote attached" },
    headers: [{ name: "In-Reply-To", value: "<m2@x>" }, { name: "References", value: "<m1@x> <m2@x>" }] }),
  msg({ id: "m4", subject: "Automatic reply: Newsletter", conversationId: "conv-2", receivedAt: d("2026-09-03T09:00:00Z"),
    headers: [{ name: "Auto-Submitted", value: "auto-replied" }] }),
  msg({ id: "draft", subject: "draft", receivedAt: d("2026-09-03T09:00:00Z"), isDraft: true }),
];
const sent: RawMessage[] = [
  msg({ id: "m2", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-01T10:00:00Z"), from: { address: OWNER, name: "Sales" },
    to: [{ address: "ali@customer.com", name: "Ali" }], cc: [{ address: REG, name: "Regulatory" }], headers: [{ name: "In-Reply-To", value: "<m1@x>" }] }),
];
// What regulatory@ (Cc'd on the thread) sees: its own Graph ids, the same Message-IDs.
const regInbox: RawMessage[] = [
  msg({ id: "m1-cc", subject: "PO 4512 – Paracetamol", receivedAt: d("2026-09-01T08:00:01Z"), internetMessageId: "<m1@x>", cc: [{ address: REG, name: "Regulatory" }], body: { contentType: "text", content: "Please quote 500 units." } }),
  msg({ id: "m2-cc", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-01T10:00:01Z"), internetMessageId: "<m2@x>", from: { address: OWNER, name: "Sales" },
    to: [{ address: "ali@customer.com", name: "Ali" }], cc: [{ address: REG, name: "Regulatory" }], headers: [{ name: "In-Reply-To", value: "<m1@x>" }] }),
];

class FakeProvider implements MailProvider {
  calls = 0;
  constructor(private readonly inboxMessages: RawMessage[] = inbox, private readonly sentMessages: RawMessage[] = sent) {}
  async resolveUser(): Promise<MailUser> { return { id: "u1", displayName: "Sales", mail: OWNER, userPrincipalName: OWNER, proxyAddresses: [] }; }
  async *listChanges(opts: ListChangesOptions): AsyncGenerator<DeltaPage, ListChangesResult, void> {
    this.calls++;
    if (opts.deltaLink) { yield { messages: [], removedIds: [] }; return { deltaLink: opts.deltaLink }; }
    const all = opts.folder === "inbox" ? this.inboxMessages : this.sentMessages;
    yield { messages: all.slice(0, 2), removedIds: [] };
    if (opts.onProgress) await opts.onProgress(`next:${opts.folder}`);
    yield { messages: all.slice(2), removedIds: ["gone"] };
    return { deltaLink: `delta:${opts.folder}` };
  }
  async getMessages(): Promise<RawMessage[]> { return []; }
  /** A migrated "Sent" folder (Zoho → Microsoft 365) next to the real Sent Items */
  migratedSent: RawMessage[] = [];
  async listMailFolders(): Promise<MailboxFolder[]> {
    return [
      { id: "f-sentitems", path: "Sent Items", displayName: "Sent Items", totalItemCount: this.sentMessages.length, isSentItems: true },
      { id: "f-zoho-sent", path: "Sent", displayName: "Sent", totalItemCount: this.migratedSent.length, isSentItems: false },
    ];
  }
  async *listFolderMessages(_userId: string, folderId: string): AsyncGenerator<RawMessage[], void, void> {
    if (folderId === "f-zoho-sent") yield this.migratedSent;
  }
  async getWebLinks(): Promise<Map<string, string | null>> { return new Map(); }
  async subscribe(): Promise<SubscriptionInfo> { throw new Error("n/a"); }
  async renew(): Promise<SubscriptionInfo> { throw new Error("n/a"); }
}

function assert(cond: unknown, label: string) { if (!cond) throw new Error(`ASSERT FAILED: ${label}`); console.log(`  ✓ ${label}`); }

const db = getDb();
try {
  await db.organization.deleteMany({ where: { domain: { in: ["example-pharma.com", "other-pharma.com"] } } });
  const org = await db.organization.create({ data: { name: "Example", slug: "example-pharma", domain: "example-pharma.com", azureTenantId: "t" } });
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
  // Search index (Ask): written by the sync from the plaintext, one statement per page; Outlook link stored.
  const vectors = await db.$queryRaw<{ gid: string; hit: boolean }[]>`SELECT "graphMessageId" AS gid, "searchVector" @@ to_tsquery('simple', 'quote & 500 & units & ali & 4512') AS hit FROM "Message" WHERE "mailboxId" = ${mb.id} AND "searchVector" IS NOT NULL`;
  assert(vectors.length === 4 && vectors.find((v) => v.gid === "m1")?.hit === true && vectors.filter((v) => v.hit).length === 1, "every synced message has a search vector built from subject, sender and cleaned body");
  assert(m1.webLink === "https://outlook.office365.com/owa/?ItemID=m1" && m2.webLink === null, "Outlook web link stored when Graph returns one");

  const t1 = await db.thread.findUniqueOrThrow({ where: { mailboxId_conversationId: { mailboxId: mb.id, conversationId: "conv-1" } } });
  assert(t1.messageCount === 3 && t1.normalizedSubject === "po 4512 – paracetamol", `thread grouped: ${t1.messageCount} msgs, "${t1.normalizedSubject}"`);
  assert(t1.status === "awaiting_us" && (t1.participants as unknown[]).length === 3, "thread status/participants (Ali, sales, Cc'd regulatory)");
  assert(t1.firstMessageAt.toISOString() === "2026-09-01T08:00:00.000Z" && t1.lastMessageAt.toISOString() === "2026-09-02T09:00:00.000Z", "thread time range");

  // Phase 2: reply detection + status (m1 received 08:00Z = 12:00 Dubai, Tue 1 Sep 2026)
  const m1r = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m1" } });
  assert(m1r.repliedAt?.toISOString() === "2026-09-01T10:05:00.000Z" && m1r.replyMethod === "outlook_verb", "m1 replied via Outlook verb (verb time wins)");
  assert(m1r.repliedByMessageId === m2.id, "m1 linked to sent message m2 (header match)");
  assert(m1r.responseMinutes === 125 && m1r.responseBusinessMinutes === 125, `m1 response 125 min raw/business (got ${m1r.responseMinutes}/${m1r.responseBusinessMinutes})`);
  const m3r = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m3" } });
  assert(m3r.repliedAt === null && m3r.replyMethod === null, "m3 unanswered");
  const m2r = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m2" } });
  assert(m2r.repliedAt === null, "outbound m2 has no reply fields");
  const t1r = await db.thread.findUniqueOrThrow({ where: { id: t1.id } });
  assert(t1r.status === "awaiting_us" && t1r.awaitingSince?.toISOString() === "2026-09-02T09:00:00.000Z", "thread 1 awaiting_us since m3");
  // m3 at 13:00 Dubai Wed 2 Sep; 24 business hours → Wed 5h, Thu 9h, Sun 9h, Mon 1h → Mon 7 Sep 10:00 Dubai = 06:00Z
  assert(t1r.overdueAt?.toISOString() === "2026-09-07T06:00:00.000Z", `thread 1 overdueAt = SLA in business hours (got ${t1r.overdueAt?.toISOString()})`);
  assert(t1r.overdueAt! <= new Date(), "thread 1 is overdue now");
  const t2 = await db.thread.findUniqueOrThrow({ where: { mailboxId_conversationId: { mailboxId: mb.id, conversationId: "conv-2" } } });
  assert(t2.status === "no_reply_needed", "auto-reply-only thread needs no reply");
  // Manual close is kept, and a new inbound reopens it
  await db.thread.update({ where: { id: t1.id }, data: { status: "closed", closedAt: new Date("2026-09-03T00:00:00Z"), closedBy: "tester" } });
  await recomputeThread(db, mb.id, "conv-1");
  assert((await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).status === "closed", "manual close kept on recompute");
  inbox.push(msg({ id: "m5", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-04T09:00:00Z") }));
  await syncMailbox(mb.id, { provider, reset: true });
  const t1re = await db.thread.findUniqueOrThrow({ where: { id: t1.id } });
  assert(t1re.status === "awaiting_us" && t1re.closedAt === null && t1re.awaitingSince?.toISOString() === "2026-09-04T09:00:00.000Z", "new inbound after close reopens thread");
  inbox.pop();
  // Alias: a message from an alias landing in the inbox counts as ours
  await db.mailbox.update({ where: { id: mb.id }, data: { aliases: ["orders@example-pharma.com"] } });
  inbox.push(msg({ id: "m6", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-05T09:00:00Z"), from: { address: "orders@example-pharma.com", name: "Orders" }, to: [{ address: "ali@customer.com" }] }));
  await syncMailbox(mb.id, { provider, reset: true });
  const t1alias = await db.thread.findUniqueOrThrow({ where: { id: t1.id } });
  const m3alias = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m3" } });
  assert(t1alias.status === "awaiting_them" && m3alias.replyMethod === "conversation_match", "alias message treated as our reply (conversation match)");
  inbox.pop();
  await db.mailbox.update({ where: { id: mb.id }, data: { aliases: [] } });
  // Migrated mailbox: the answer to m3 sits in the old provider's "Sent" folder, not in Sent Items.
  provider.migratedSent = [msg({ id: "m7", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-02T11:00:00Z"), from: { address: OWNER, name: "Sales" },
    to: [{ address: "ali@customer.com", name: "Ali" }], headers: [{ name: "In-Reply-To", value: "<m3@x>" }] })];
  const sentFolders = (await provider.listMailFolders()).filter((f) => !f.isSentItems);
  const imp = await importSentFolders(mb.id, sentFolders, { provider });
  const m7 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m7" } });
  const m3imp = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m3" } });
  assert(imp.folders[0]?.upserted === 1 && m7.direction === "outbound" && m7.folder === "sent", "migrated Sent folder imported as sent mail");
  assert(m3imp.repliedByMessageId === m7.id && (await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).status === "awaiting_them", "a reply in the migrated folder answers m3");
  provider.migratedSent = [];
  // Sync never deletes (read-only mirror), so drop the scenario messages ourselves and recompute.
  await db.message.deleteMany({ where: { graphMessageId: { in: ["m5", "m6", "m7"] } } });
  await recomputeThread(db, mb.id, "conv-1");
  assert((await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).status === "awaiting_us", "recompute after removing scenario messages restores awaiting_us");

  // Phase 3: mocked AI step (no API calls). The fake client returns a fixed tool call.
  console.log("AI summaries (mocked client)");
  process.env.ANTHROPIC_API_KEY ||= "fake-key-for-tests";
  let aiCalls = 0;
  const fakeAi = (input: Record<string, unknown>): SummaryClient => ({
    messages: { create: async () => { aiCalls++; return { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
      content: [{ type: "tool_use", id: "t", name: SUMMARY_TOOL_NAME, input }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message; } } as unknown as Anthropic["messages"],
  });
  const summaryInput = { summary: "Ali asked for a quote for 500 units; we replied and he confirmed.", key_points: ["500 units"], asks: [], next_action: null, needs_reply: false, category: "customer", priority: "normal", concluded: false, language: "en" };
  const plan = await planBackfill({ mailboxIds: [mb.id] });
  assert(plan.estimate.threads === 2 && plan.estimate.costUsd > 0 && plan.items[0]!.request.user.includes("<email_thread>"), `dry-run plan: ${plan.estimate.threads} threads, est $${plan.estimate.costUsd.toFixed(5)}`);
  const debounced = await summarizeThread(t1.id, { client: fakeAi(summaryInput), now: new Date("2026-09-02T09:01:00Z") });
  assert(debounced.outcome === "skipped" && debounced.reason === "debounce", "debounce window respected");
  const ai1 = await summarizeThread(t1.id, { client: fakeAi(summaryInput) });
  assert(ai1.outcome === "summarized" && ai1.status === "no_reply_needed", `thread summarized → status ${ai1.status}`);
  const t1ai = await db.thread.findUniqueOrThrow({ where: { id: t1.id } });
  assert(t1ai.summary === summaryInput.summary && t1ai.category === "customer" && t1ai.summaryMessageCount === 3 && t1ai.needsReplyDecidedBy === "ai" && !t1ai.needsReply, "summary fields + AI decision saved");
  const usage = await db.aiUsage.findMany({ where: { threadId: t1.id } });
  assert(usage.length === 1 && usage[0]!.costUsd > 0 && usage[0]!.cacheReadTokens === 800, `usage logged: $${usage[0]!.costUsd.toFixed(6)}`);
  const again = await summarizeThread(t1.id, { client: fakeAi(summaryInput) });
  assert(again.outcome === "skipped" && again.reason === "nothing_new" && aiCalls === 1, "no re-summarize without new messages");
  // New inbound resets the AI decision and the thread goes back to awaiting_us until re-summarized
  inbox.push(msg({ id: "m7", subject: "RE: PO 4512 – Paracetamol", receivedAt: new Date() }));
  await syncMailbox(mb.id, { provider, reset: true });
  const t1new = await db.thread.findUniqueOrThrow({ where: { id: t1.id } });
  assert(t1new.status === "awaiting_us" && t1new.needsReply && t1new.needsReplyDecidedBy === null, "new inbound resets the AI decision → awaiting_us");
  // Invalid output twice → summaryError, no crash
  const bad = await summarizeThread(t1.id, { client: fakeAi({ ...summaryInput, priority: "critical" }), force: true });
  assert(bad.outcome === "error" && bad.reason?.startsWith("invalid_output") && aiCalls === 3, "invalid output → retried once → summaryError");
  assert((await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).summaryError?.includes("invalid_output"), "summaryError stored");
  // Concluded → closed by AI when not awaiting us
  const concluded = { ...summaryInput, concluded: true };
  const okAgain = await summarizeThread(t1.id, { client: fakeAi(concluded), force: true });
  assert(okAgain.outcome === "summarized" && okAgain.status === "closed", "concluded + no reply needed → closed by AI");
  assert((await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).closedBy === "ai", "closedBy = ai");
  // User decision is sticky against the AI, until a new inbound
  await db.thread.update({ where: { id: t1.id }, data: { status: "no_reply_needed", closedAt: null, closedBy: null, needsReply: false, needsReplyDecidedBy: "user", needsReplyDecidedAt: new Date() } });
  const userSticky = await summarizeThread(t1.id, { client: fakeAi({ ...summaryInput, needs_reply: true }), force: true });
  assert(userSticky.status === "no_reply_needed" && (await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).needsReplyDecidedBy === "user", "user decision beats AI needs_reply");
  // summarizeThreads over the mailbox + cap
  const many = await summarizeThreads({ mailboxId: mb.id, client: fakeAi(summaryInput), force: true });
  assert(many.candidates === 2 && many.summarized + many.errors + Object.values(many.skipped).reduce((a, b) => a + b, 0) === 2, `summarizeThreads ran over ${many.candidates} threads`);
  await db.message.deleteMany({ where: { graphMessageId: "m7" } });
  inbox.pop();
  await recomputeThread(db, mb.id, "conv-1");

  const mbAfter = await db.mailbox.findUniqueOrThrow({ where: { id: mb.id } });
  assert(mbAfter.inboxDeltaLink === "delta:inbox" && mbAfter.sentDeltaLink === "delta:sentitems" && mbAfter.lastSyncedAt, "delta links + lastSyncedAt saved");

  console.log("second sync (incremental, idempotent)");
  const s2 = await syncMailbox(mb.id, { provider });
  assert(s2.folders.inbox.upserted === 0, "incremental pulled nothing new");
  assert((await db.message.count({ where: { mailboxId: mb.id } })) === 4, "no duplicates");

  console.log("reset sync");
  const s3 = await syncMailbox(mb.id, { provider, reset: true });
  assert(s3.folders.inbox.upserted === 3 && (await db.message.count({ where: { mailboxId: mb.id } })) === 4, "reset re-upserts without duplicates");

  // Copies across mailboxes: regulatory@ was Cc'd on the thread and on our reply-all.
  console.log("copies across mailboxes (Cc'd colleague)");
  assert(m1.internalRecipients.length === 1 && m1.internalRecipients[0] === REG, "m1 lists the Cc'd colleague as an in-company recipient");
  const mb2 = await db.mailbox.create({ data: { orgId: org.id, emailAddress: REG, graphUserId: "u2" } });
  const s4 = await syncMailbox(mb2.id, { provider: new FakeProvider(regInbox, []) });
  assert(s4.folders.inbox.upserted === 2 && s4.duplicates === 2, `regulatory sync: 2 upserted, both linked as copies (got ${s4.duplicates})`);
  assert(s4.siblingThreadsRecomputed === 1, `sales thread recomputed as a sibling (got ${s4.siblingThreadsRecomputed})`);
  const m1cc = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m1-cc" } });
  const m2cc = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m2-cc" } });
  assert(m1cc.duplicateOfId === m1.id && m1cc.internalRecipients[0] === OWNER, "Cc copy of m1 → copy of the sales row (sales was in To)");
  assert(m2cc.direction === "inbound" && m2cc.duplicateOfId === m2.id, "inbox copy of our reply-all → copy of the Sent Items row");
  // The email was addressed To sales@: regulatory@ was only Cc'd, so its copy is not received mail there (no reply fields, never waiting).
  assert(m1cc.excludedBy === "auto:cc" && m1cc.exclusionAction === "no_reply_needed" && m1cc.repliedAt === null, `regulatory's copy of an email sent To sales@ is a Cc copy (${m1cc.excludedBy})`);
  const tReg = await db.thread.findUniqueOrThrow({ where: { mailboxId_conversationId: { mailboxId: mb2.id, conversationId: "conv-1" } } });
  assert(tReg.duplicateOfId === t1.id && tReg.status === "no_reply_needed" && tReg.exclusionAction === "no_reply_needed", `regulatory thread is a copy of the sales thread and not waiting (${tReg.status})`);
  // With the switch off the copy is received mail in regulatory@ too, answered by sales' reply (cross-mailbox header match).
  await db.organization.update({ where: { id: org.id }, data: { settings: { ccNoReply: false } } });
  await reapplyExclusions(db, org.id);
  const m1ccOff = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m1-cc" } });
  assert(m1ccOff.excludedBy === null && m1ccOff.repliedAt?.toISOString() === "2026-09-01T10:00:00.000Z" && m1ccOff.replyMethod === "header_match" && m1ccOff.repliedByMessageId === m2.id, "switch off: sales' reply answers regulatory's copy (cross-mailbox header match)");
  assert((await db.thread.findUniqueOrThrow({ where: { id: tReg.id } })).status === "awaiting_them", "switch off: regulatory's copy thread is answered, not waiting");
  await db.organization.update({ where: { id: org.id }, data: { settings: {} } });
  await reapplyExclusions(db, org.id);
  assert((await db.message.findUniqueOrThrow({ where: { graphMessageId: "m1-cc" } })).excludedBy === "auto:cc" && (await db.thread.findUniqueOrThrow({ where: { id: tReg.id } })).status === "no_reply_needed", "switch back on: the copy is excluded again");
  const allScope = mailboxScope({ orgId: org.id });
  assert((await db.message.count({ where: { ...allScope, direction: "inbound" } })) === 3 && (await db.message.count({ where: { mailboxId: mb2.id, direction: "inbound" } })) === 2, "all-mailboxes counts once; the single mailbox still sees its copies");
  assert((await db.thread.count({ where: { ...allScope, conversationId: "conv-1" } })) === 1, "all-mailboxes lists the conversation once");
  // Race: both mailboxes synced the same email at the same moment and neither saw the other's copy yet.
  await db.message.updateMany({ where: { mailboxId: mb2.id }, data: { duplicateOfId: null } });
  await recomputeThread(db, mb2.id, "conv-1");
  assert((await db.thread.count({ where: { ...allScope, conversationId: "conv-1" } })) === 2, "race reproduced: the unlinked copy shows twice in all-mailboxes");
  const swept = await relinkRecentCopies(db, org.id, d("2026-08-01T00:00:00Z"));
  assert(swept.threadsRecomputed > 0 && (await db.thread.count({ where: { ...allScope, conversationId: "conv-1" } })) === 1 && (await db.thread.findUniqueOrThrow({ where: { id: tReg.id } })).duplicateOfId === t1.id, "the copy sweep after a sync links them again and the thread shows once");
  assert((await relinkRecentCopies(db, org.id, d("2026-08-01T00:00:00Z"))).threadsRecomputed === 0, "the sweep changes nothing when the copies are already linked");
  const callsBefore = aiCalls;
  const copied = await summarizeThread(tReg.id, { client: fakeAi(summaryInput), force: true });
  const tRegAi = await db.thread.findUniqueOrThrow({ where: { id: tReg.id } });
  assert(copied.outcome === "skipped" && copied.reason === "duplicate_copied" && aiCalls === callsBefore && tRegAi.summary === (await db.thread.findUniqueOrThrow({ where: { id: t1.id } })).summary, "copy thread inherits the primary's summary without an API call");
  // Our own reply is also a primary message in regulatory's view only when addressed To it: send one directly.
  const direct = msg({ id: "m8", subject: "Internal: stock count", conversationId: "conv-3", receivedAt: d("2026-09-06T09:00:00Z"), internetMessageId: "<m8@x>", from: { address: OWNER, name: "Sales" }, to: [{ address: REG, name: "Regulatory" }] });
  await syncMailbox(mb.id, { provider: new FakeProvider(inbox, [...sent, { ...direct, id: "m8-sent", receivedAt: d("2026-09-06T09:00:00Z") }]), reset: true });
  await syncMailbox(mb2.id, { provider: new FakeProvider([...regInbox, direct], []), reset: true });
  const m8 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m8" } });
  const tDirect = await db.thread.findUniqueOrThrow({ where: { mailboxId_conversationId: { mailboxId: mb2.id, conversationId: "conv-3" } } });
  assert(m8.duplicateOfId === null && m8.excludedBy === "auto:internal" && tDirect.duplicateOfId === null && tDirect.status === "no_reply_needed" && tDirect.category === "internal", `an email between colleagues needs no reply and is categorised internal (${tDirect.status}, ${tDirect.category})`);
  await db.organization.update({ where: { id: org.id }, data: { settings: { internalNoReply: false } } });
  await reapplyExclusions(db, org.id);
  assert((await db.thread.findUniqueOrThrow({ where: { id: tDirect.id } })).status === "awaiting_us", "with internal detection switched off, an internal email addressed To the colleague is a real request");
  await db.organization.update({ where: { id: org.id }, data: { settings: {} } });
  await reapplyExclusions(db, org.id);
  // A colleague whose mailbox is not tracked answers the customer with us in Cc: that is the company replying.
  const ceoReply = msg({ id: "m9", subject: "RE: PO 4512 – Paracetamol", receivedAt: d("2026-09-02T12:00:00Z"), from: { address: "ceo@example-pharma.com", name: "CEO" },
    to: [{ address: "ali@customer.com", name: "Ali" }], cc: [{ address: OWNER, name: "Sales" }], headers: [{ name: "In-Reply-To", value: "<m3@x>" }] });
  await syncMailbox(mb.id, { provider: new FakeProvider([...inbox, ceoReply]), reset: true });
  const m9 = await db.message.findUniqueOrThrow({ where: { graphMessageId: "m9" } });
  assert(m9.excludedBy === "auto:internal" && (await db.message.findUniqueOrThrow({ where: { graphMessageId: "m3" } })).repliedByMessageId === m9.id, "a colleague's reply to the customer (we were Cc'd) answers the customer's email");
  await db.message.delete({ where: { id: m9.id } });
  await recomputeThread(db, mb.id, "conv-1");

  // Period summary (mocked client): figures from the DB, text from the model.
  console.log("period summary (mocked client)");
  const fakePeriodAi: SummaryClient = { messages: { create: async () => { aiCalls++; return { id: "p", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "tool_use", stop_sequence: null,
    content: [{ type: "tool_use", id: "t", name: PERIOD_SUMMARY_TOOL_NAME, input: { overview: "One customer thread, answered.", received: ["Ali asked for a quote for 500 units"], sent: ["Quote sent to Ali"], needs_attention: [] } }], usage: { input_tokens: 700, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 600 } } as unknown as Anthropic.Message; } } as unknown as Anthropic["messages"] };
  const at = d("2026-09-10T08:00:00Z");
  const pAll = await summarizePeriod({ orgId: org.id, mailboxId: null, period: "month", now: at, client: fakePeriodAi, createdBy: "check" });
  // m8 (a colleague's email) is readable context, not received mail: like the KPIs, the figures only count mail that is not excluded.
  assert(pAll.outcome === "summarized" && pAll.stats?.received === 2 && pAll.stats.sent === 2 && pAll.stats.replied === 1 && pAll.stats.threads === 3 && pAll.stats.mailboxes === 2, `all mailboxes, last 30 days: ${JSON.stringify(pAll.stats)}`);
  assert(pAll.record?.overview === "One customer thread, answered." && pAll.record.costUsd > 0 && pAll.record.scopeKey === "all", "digest stored with cost");
  const pReg = await summarizePeriod({ orgId: org.id, mailboxId: mb2.id, period: "month", now: at, client: fakePeriodAi });
  assert(pReg.stats?.received === 0 && pReg.stats.sent === 0 && pReg.stats.threads === 2, `single mailbox: its Cc copies and colleagues' mail are context, not received mail: ${JSON.stringify(pReg.stats)}`);
  const pEmpty = await summarizePeriod({ orgId: org.id, mailboxId: null, period: "day", now: d("2026-12-01T08:00:00Z"), client: fakePeriodAi });
  assert(pEmpty.outcome === "skipped" && pEmpty.reason === "no_activity", "empty window → skipped without an API call");
  const latest = await latestPeriodSummary(db, org.id, null, "month");
  assert(latest?.id === pAll.record?.id && (await db.periodSummary.count({ where: { orgId: org.id } })) === 2, "latest digest per scope/period retrievable");

  // Exclusion rules: default rules, built-in detection, mixed threads, AI skipped, re-apply, company isolation.
  console.log("exclusion rules");
  assert((await seedDefaultRules(db, org.id)) === 5 && (await seedDefaultRules(db, org.id)) === 0, "default rules seeded once (idempotent)");
  const recent = (h: number) => new Date(Date.now() - h * 3_600_000);
  const noisy: RawMessage[] = [
    msg({ id: "x-gd", conversationId: "conv-gd", subject: "Your GoDaddy renewal receipt", receivedAt: recent(30), from: { address: "Billing@email.GoDaddy.com", name: "GoDaddy" } }),
    msg({ id: "x-nl", conversationId: "conv-nl", subject: "October pricing bulletin", receivedAt: recent(29), from: { address: "news@vendor.com", name: "Vendor News" }, headers: [{ name: "List-Unsubscribe", value: "<mailto:unsub@vendor.com>" }] }),
    msg({ id: "x-other", conversationId: "conv-other", subject: "Webinar invitation", receivedAt: recent(28), from: { address: "events@partner.com", name: "Partner" }, inferenceClassification: "other" }),
    msg({ id: "x-mix1", conversationId: "conv-mix", subject: "Ticket 881 opened", receivedAt: recent(27), from: { address: "noreply@portal.com", name: "Portal" }, body: { contentType: "text", content: "PORTAL-NOISE ticket opened" } }),
    msg({ id: "x-mix2", conversationId: "conv-mix", subject: "RE: Ticket 881 opened", receivedAt: recent(26), from: { address: "omar@customer.com", name: "Omar" }, body: { contentType: "text", content: "Can you call me about ticket 881?" } }),
  ];
  const receivedBefore = (await collectPeriodActivity(db, { orgId: org.id, mailboxId: null, from: recent(48), to: new Date() })).stats.received;
  await syncMailbox(mb.id, { provider: new FakeProvider([...inbox, ...noisy], sent), reset: true });
  const byGraphId = async (id: string) => db.message.findUniqueOrThrow({ where: { graphMessageId: id } });
  const threadOf = async (conv: string) => db.thread.findUniqueOrThrow({ where: { mailboxId_conversationId: { mailboxId: mb.id, conversationId: conv } } });
  const gdRule = await db.exclusionRule.findFirstOrThrow({ where: { orgId: org.id, defaultKey: "godaddy" } });
  const gd = await byGraphId("x-gd");
  assert(gd.exclusionAction === "ignore" && gd.excludedBy === gdRule.id, "godaddy.com rule matches email.godaddy.com (subdomain, case-insensitive) → ignore");
  const tGd = await threadOf("conv-gd");
  assert(tGd.exclusionAction === "ignore" && tGd.status === "no_reply_needed" && tGd.category === "notification", "thread of only ignored mail: hidden, no reply needed, category notification");
  const nl = await byGraphId("x-nl");
  assert(nl.exclusionAction === "no_reply_needed" && nl.excludedBy === "auto:list-unsubscribe" && nl.autoSignals[0] === "list-unsubscribe", "List-Unsubscribe header → auto no_reply_needed with the reason stored");
  const other = await byGraphId("x-other");
  assert(other.excludedBy === "auto:focused-other" && other.inferenceClassification === "other" && (await threadOf("conv-other")).status === "no_reply_needed", "Outlook \"Other\" → no_reply_needed");
  const tMix = await threadOf("conv-mix");
  assert((await byGraphId("x-mix1")).excludedBy === "auto:noreply" && (await byGraphId("x-mix2")).exclusionAction === null, "noreply sender excluded, the person replying in the same thread is not");
  assert(tMix.exclusionAction === null && tMix.status === "awaiting_us" && tMix.awaitingSince?.getTime() === (await byGraphId("x-mix2")).receivedAt.getTime(), "mixed thread is not excluded and waits for our reply to the real person");
  const aiBefore = aiCalls;
  const skippedAi = await summarizeThread(tGd.id, { client: fakeAi(summaryInput), force: true });
  assert(skippedAi.outcome === "skipped" && skippedAi.reason === "excluded" && aiCalls === aiBefore, "AI is not called for an excluded thread, even when forced");
  const planEx = await planBackfill({ mailboxIds: [mb.id] });
  const mixItem = planEx.items.find((i) => i.threadId === tMix.id);
  assert(!planEx.items.some((i) => [tGd.id, nl.threadId, other.threadId].includes(i.threadId)), "excluded threads are not planned for summarization");
  assert(!!mixItem && mixItem.request.user.includes("ticket 881?") && !mixItem.request.user.includes("PORTAL-NOISE"), "mixed thread: only the real message is sent to the AI");
  const act = await collectPeriodActivity(db, { orgId: org.id, mailboxId: null, from: recent(48), to: new Date() });
  assert(act.stats.received === receivedBefore + 1 && act.threads.every((t) => t.id !== tGd.id), `figures count only the real email (${act.stats.received} vs ${receivedBefore} before)`);

  // Company isolation: the same mail in another company is untouched by this company's rules.
  const orgB = await db.organization.create({ data: { name: "Other", slug: "other-pharma", domain: "other-pharma.com", azureTenantId: "t" } });
  const mbB = await db.mailbox.create({ data: { orgId: orgB.id, emailAddress: "info@other-pharma.com", graphUserId: "u9" } });
  await syncMailbox(mbB.id, { provider: new FakeProvider([msg({ id: "b-gd", conversationId: "conv-b", subject: "Your GoDaddy renewal receipt", receivedAt: recent(30), from: { address: "billing@email.godaddy.com", name: "GoDaddy" }, to: [{ address: "info@other-pharma.com" }] })], []) });
  const bGd = await byGraphId("b-gd");
  assert(bGd.exclusionAction === null && bGd.excludedBy === null, "company A's rules do not apply to company B's mail");
  assert((await countRuleMatches(db, org.id, gdRule)) === 1 && (await countRuleMatches(db, orgB.id, gdRule)) === 1, "preview counts stay inside one company (1 match each, not 2)");

  // Adding / deactivating a rule re-applies it to stored mail and recomputes the threads.
  const omar = await db.exclusionRule.create({ data: { orgId: org.id, type: "sender_email", value: "omar@customer.com", action: "no_reply_needed", createdBy: "check" } });
  const re1 = await reapplyExclusions(db, org.id);
  const tMix2 = await threadOf("conv-mix");
  assert(re1.changed === 1 && re1.threadsRecomputed === 1 && tMix2.exclusionAction === "no_reply_needed" && tMix2.status === "no_reply_needed" && tMix2.overdueAt === null, `new rule re-applied to stored mail (${re1.changed} changed) → thread no longer waits`);
  assert((await reapplyExclusions(db, org.id)).changed === 0, "re-applying again changes nothing (idempotent)");
  assert((await byGraphId("b-gd")).exclusionAction === null && (await db.message.count({ where: { mailbox: { orgId: orgB.id }, exclusionAction: { not: null } } })) === 0, "re-apply never touches another company");
  await db.exclusionRule.update({ where: { id: omar.id }, data: { isActive: false } });
  const re2 = await reapplyExclusions(db, org.id);
  const tMix3 = await threadOf("conv-mix");
  assert(re2.changed === 1 && tMix3.exclusionAction === null && tMix3.status === "awaiting_us" && tMix3.category === "other" && tMix3.summaryMessageCount === 0, "deactivating the rule restores the thread (awaiting our reply, back in the AI queue)");
  // A mailbox-specific rule only applies to that mailbox.
  const scoped = await db.exclusionRule.create({ data: { orgId: org.id, mailboxId: mb2.id, type: "subject_contains", value: "ticket 881", action: "ignore", createdBy: "check" } });
  assert((await reapplyExclusions(db, org.id)).changed === 0 && (await countRuleMatches(db, org.id, scoped)) === 0, "a rule scoped to another mailbox does not match");
  // Detection can be switched off per company; the stored signals bring it back when re-enabled.
  await db.organization.update({ where: { id: org.id }, data: { settings: { autoExclude: false, outlookOtherNoReply: false } } });
  const off = await reapplyExclusions(db, org.id);
  assert(off.changed === 3 && (await byGraphId("x-nl")).exclusionAction === null && (await byGraphId("x-gd")).exclusionAction === "ignore", "auto-detection off: 3 auto-excluded emails count again, rules still apply");
  await db.organization.update({ where: { id: org.id }, data: { settings: {} } });
  assert((await reapplyExclusions(db, org.id)).changed === 3 && (await byGraphId("x-other")).excludedBy === "auto:focused-other", "auto-detection back on from the stored signals");

  await db.organization.deleteMany({ where: { domain: { in: ["example-pharma.com", "other-pharma.com"] } } });
  console.log("\nALL CHECKS PASSED");
} finally {
  await disconnectDb();
}
