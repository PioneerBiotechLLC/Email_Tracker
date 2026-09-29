/**
 * Local integration check for the sync engine using a fake MailProvider
 * (no Graph credentials needed). Run against any Postgres:
 *   DATABASE_URL=... AZURE_TENANT_ID=t AZURE_CLIENT_ID=c AZURE_CLIENT_SECRET=s pnpm exec tsx scripts/fake-sync.ts
 */
import { getDb, disconnectDb, syncMailbox, readBody, recomputeThread, summarizeThread, summarizeThreads, planBackfill, SUMMARY_TOOL_NAME, type SummaryClient } from "../src/index.js";
import type Anthropic from "@anthropic-ai/sdk";
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
  // Sync never deletes (read-only mirror), so drop the scenario messages ourselves and recompute.
  await db.message.deleteMany({ where: { graphMessageId: { in: ["m5", "m6"] } } });
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

  await db.organization.deleteMany({ where: { domain: "example-pharma.com" } });
  console.log("\nALL CHECKS PASSED");
} finally {
  await disconnectDb();
}
