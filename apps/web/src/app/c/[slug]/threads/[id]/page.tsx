import Link from "next/link";
import { notFound } from "next/navigation";
import { domainOf, orgDomains } from "@email-tracker/core";
import { ignoreSender } from "@/actions/rules";
import { classifyThread, closeThread, reopenThread, resummarizeThread, setNeedsReply } from "@/actions/thread";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/shared/action-button";
import { ConfirmForm } from "@/components/shared/confirm-form";
import { CategoryChip, ExcludedBadge, PriorityChip, StatusBadge } from "@/components/shared/badges";
import { IgnoreMenu } from "@/components/shared/ignore-menu";
import { RuleBanner } from "@/components/shared/rule-banner";
import { getThreadDetail } from "@/lib/data/thread-detail";
import { chatEnabled } from "@/lib/chat-flag";
import { CATEGORY_LABEL, formatDateTime, formatMinutes, formatSince, titleCase, summaryErrorText } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";
import { cn } from "@/lib/utils";

const METHOD: Record<string, string> = { outlook_verb: "Outlook reply verb", header_match: "email headers", conversation_match: "conversation match" };
export const maxDuration = 60; // the quick "ignore" actions re-apply the rules to stored mail

export default async function ThreadPage({ params, searchParams }: { params: Promise<{ slug: string; id: string }>; searchParams: Promise<{ ai?: string; detail?: string; rule?: string; affected?: string }> }) {
  const { slug, id } = await params;
  const sp = await searchParams;
  const { ctx, org } = await getCompanyContext(slug);
  const base = `/c/${slug}`;
  const data = await getThreadDetail(ctx, id);
  if (!data) notFound();
  const { thread, messages } = data;
  const tz = org.timezone;
  const now = new Date();
  const owners = new Set([thread.mailbox.emailAddress, ...thread.mailbox.aliases]);
  const isAdmin = ctx.role === "admin";
  const ownDomains = orgDomains(org);
  const returnTo = `${base}/threads/${thread.id}`;
  const askHref = (await chatEnabled()) ? `${base}/ask?thread=${thread.id}&q=${encodeURIComponent("What is the current status of this thread, and what is still open?")}` : null;
  const asks = Array.isArray(thread.asks) ? (thread.asks as { from: string; ask: string; due: string | null }[]) : [];
  const keyPoints = Array.isArray(thread.keyPoints) ? (thread.keyPoints as string[]) : [];
  // Other mailboxes of the company that hold copies of these emails (we were Cc'd, or they were)
  const alsoIn = new Map<string, string>();
  for (const m of messages) for (const d of m.duplicates) if (!alsoIn.has(d.mailbox.emailAddress)) alsoIn.set(d.mailbox.emailAddress, d.threadId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`${base}/threads`} className="text-sm text-muted-foreground hover:underline">← Threads</Link>
        {askHref && <Button asChild variant="outline" size="sm" className="ms-auto"><Link href={askHref}>Ask about this thread</Link></Button>}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold" dir="auto">{thread.subject || "(no subject)"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={thread.status} overdueAt={thread.overdueAt} now={now} />
            <CategoryChip category={thread.category} /><PriorityChip priority={thread.priority} />
            {thread.exclusionAction && <ExcludedBadge action={thread.exclusionAction} />}
            <span>{thread.mailbox.emailAddress} · {messages.length} messages</span>
            {!thread.duplicateOf && alsoIn.size > 0 && <span>· also received by {[...alsoIn.entries()].map(([addr, tid], i) => <span key={addr}>{i > 0 && ", "}<Link href={`${base}/threads/${tid}`} className="underline">{addr}</Link></span>)}</span>}
            {thread.status === "awaiting_us" && thread.awaitingSince && <span>· waiting {formatSince(thread.awaitingSince, now)}</span>}
            {thread.status === "closed" && <span>· closed by {thread.closedBy === "ai" ? "the AI (concluded)" : thread.closedBy}</span>}
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2" aria-label="Thread actions">
            {/* Reversible actions run straight away (each has its opposite right here); only spending AI money asks first. */}
            {thread.status === "closed"
              ? <ActionButton variant="outline" action={reopenThread.bind(null, thread.id)} pendingLabel="Reopening…" title="A new inbound email also reopens it">Reopen</ActionButton>
              : <ActionButton variant="outline" action={closeThread.bind(null, thread.id)} pendingLabel="Closing…" title="A new inbound email reopens it">Mark closed</ActionButton>}
            {thread.needsReply
              ? <ActionButton variant="outline" action={setNeedsReply.bind(null, thread.id, false)} pendingLabel="Saving…" title="Stays until a new email arrives in the thread">No reply needed</ActionButton>
              : <ActionButton variant="outline" action={setNeedsReply.bind(null, thread.id, true)} pendingLabel="Saving…">Needs reply</ActionButton>}
            {!thread.exclusionAction && !thread.duplicateOf && (thread.summary
              ? <ConfirmForm action={resummarizeThread.bind(null, thread.id)} confirmText="Re-summarize with Claude now? This uses one AI call (counts toward the daily cap).">Re-summarize</ConfirmForm>
              : <ConfirmForm action={resummarizeThread.bind(null, thread.id)} confirmText="Summarize this thread with Claude now? This uses one AI call (counts toward the daily cap).">Summarize</ConfirmForm>)}
          </div>
        )}
      </div>
      {thread.duplicateOf && (
        <div className="rounded-md border px-3 py-2 text-sm status-muted" role="note" data-testid="duplicate-notice">
          Copy: these emails were also received by <strong>{thread.duplicateOf.mailbox.emailAddress}</strong>, where the thread is tracked and summarized. It is hidden from the &quot;All mailboxes&quot; views so nothing is counted twice.{" "}
          <Link href={`${base}/threads/${thread.duplicateOf.id}`} className="underline">Open the primary thread</Link>.
        </div>
      )}
      <RuleBanner orgId={org.id} rule={sp.rule} affected={sp.affected} returnTo={returnTo} />
      {thread.exclusionAction && (
        <div className="rounded-md border px-3 py-2 text-sm status-muted" role="note" data-testid="excluded-notice">
          {thread.exclusionAction === "ignore"
            ? "Every incoming email in this thread is ignored by an exclusion rule: the thread is hidden from the tracker, threads and statistics (use \"Show excluded\" to list it) and is not sent to the AI."
            : "Every incoming email in this thread is excluded (no reply needed): it is never counted as awaiting a reply or overdue, and is not sent to the AI."}
          {isAdmin && <> <Link href={`${base}/settings#exclusion-rules`} className="underline">Manage exclusion rules</Link>.</>}
        </div>
      )}
      {sp.ai && (
        <div className={cn("rounded-md border px-3 py-2 text-sm", sp.ai === "summarized" ? "status-replied" : "status-waiting")} role="status">
          {sp.ai === "summarized" ? `Summary updated (${sp.detail}).` : `Summary not updated: ${sp.ai}${sp.detail ? ` — ${sp.detail}` : ""}.`}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <section aria-label="Messages" className="flex flex-col gap-3">
          {messages.map((m) => {
            const ours = m.direction === "outbound" || owners.has(m.fromAddress);
            return (
              <article key={m.id} id={`msg-${m.id}`} className={cn("max-w-[92%] scroll-mt-24 rounded-lg border p-3 text-sm target:ring-2 target:ring-primary", ours ? "self-end bg-secondary" : "self-start bg-card", m.isAutoReply && "opacity-60")}>
                <header className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground" dir="auto">{m.fromName || m.fromAddress}</span>
                  {m.fromName && <span>{m.fromAddress}</span>}
                  <span>· {formatDateTime(m.direction === "outbound" && m.sentAt ? m.sentAt : m.receivedAt, tz, now)}</span>
                  {m.isAutoReply && <span className="rounded bg-muted px-1">automatic reply</span>}
                  {m.hasAttachments && <span>· 📎</span>}
                  {m.duplicateOf && <span className="rounded bg-muted px-1" title={`The same email is tracked in ${m.duplicateOf.mailbox.emailAddress}`}>copy of {m.duplicateOf.mailbox.emailAddress}</span>}
                  {m.exclusionAction && <ExcludedBadge action={m.exclusionAction} reason={m.excludedReason} />}
                  {isAdmin && !ours && m.exclusionAction !== "ignore" && domainOf(m.fromAddress) && !ownDomains.has(domainOf(m.fromAddress)) && (
                    <span className="ms-auto"><IgnoreMenu address={m.fromAddress} domain={domainOf(m.fromAddress)} ignoreSender={ignoreSender.bind(null, org.id, m.id, "sender_email", returnTo)} ignoreDomain={ignoreSender.bind(null, org.id, m.id, "sender_domain", returnTo)} /></span>
                  )}
                </header>
                {m.internalRecipients.length > 0 && <p className="mb-1 text-xs text-muted-foreground">Also to (in-company): {m.internalRecipients.join(", ")}</p>}
                <div className="whitespace-pre-wrap break-words" dir="auto">{m.body || <span className="italic text-muted-foreground">(empty)</span>}</div>
                {!ours && !m.isAutoReply && !m.exclusionAction && (
                  <footer className="mt-2 border-t pt-1.5 text-xs text-muted-foreground">
                    {m.repliedAt ? (
                      <>Replied {formatDateTime(m.repliedAt, tz, now)} via {METHOD[m.replyMethod ?? ""] ?? "?"} · {formatMinutes(m.responseBusinessMinutes)} business ({formatMinutes(m.responseMinutes)} raw)
                        {m.repliedBy && (m.repliedBy.mailbox.emailAddress === thread.mailbox.emailAddress
                          ? <> · <a href={`#msg-${m.repliedBy.id}`} className="underline">see reply</a></>
                          : <> · answered from <strong>{m.repliedBy.mailbox.emailAddress}</strong></>)}</>
                    ) : thread.status === "awaiting_us" ? <span className="text-status-warn">Not replied yet</span> : <span>No reply recorded</span>}
                    {m.lastVerb === 104 && <span> · forwarded</span>}
                  </footer>
                )}
              </article>
            );
          })}
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">AI summary</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {thread.summary ? (
                <>
                  <p dir="auto">{thread.summary}</p>
                  {keyPoints.length > 0 && <div><h3 className="mb-1 font-sans text-xs font-semibold uppercase text-muted-foreground">Key points</h3><ul className="list-disc space-y-0.5 ps-5" dir="auto">{keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul></div>}
                  {asks.length > 0 && <div><h3 className="mb-1 font-sans text-xs font-semibold uppercase text-muted-foreground">Asks</h3><ul className="space-y-1" dir="auto">{asks.map((a, i) => <li key={i}><span className="font-medium">{a.from}:</span> {a.ask}{a.due && <span className="text-muted-foreground"> · due {a.due}</span>}</li>)}</ul></div>}
                  <div><h3 className="mb-1 font-sans text-xs font-semibold uppercase text-muted-foreground">Next action</h3><p dir="auto">{thread.nextAction ?? <span className="text-muted-foreground">Nothing for our side</span>}</p></div>
                  <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <dt>Needs reply</dt><dd>{thread.needsReply ? "Yes" : "No"}{thread.needsReplyDecidedBy && ` (${thread.needsReplyDecidedBy})`}</dd>
                    <dt>Language</dt><dd>{thread.summaryLang ?? "–"}</dd>
                    <dt>Updated</dt><dd>{formatDateTime(thread.summaryUpdatedAt, tz, now)}{thread.messageCount > thread.summaryMessageCount && " · new messages since (Re-summarize to include them)"}</dd>
                    <dt>Model</dt><dd>{thread.summaryModel ?? "–"}</dd>
                  </dl>
                </>
              ) : thread.summaryError ? (
                <p className="text-status-bad" title={summaryErrorText(thread.summaryError).detail}>{summaryErrorText(thread.summaryError).text}</p>
              ) : thread.exclusionAction ? (
                <p className="text-muted-foreground">Excluded mail is not summarized.</p>
              ) : <p className="italic text-muted-foreground">No AI summary yet. Summaries are made on request{isAdmin ? ": use Summarize above (one AI call)." : " by a company admin."}</p>}
              {thread.summaryError && thread.summary && <p className="text-xs text-status-bad" title={summaryErrorText(thread.summaryError).detail}>Last update failed: {summaryErrorText(thread.summaryError).text}</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Classification</CardTitle></CardHeader>
            <CardContent>
              {isAdmin ? (
                <form action={classifyThread.bind(null, thread.id)} className="space-y-2 text-sm">
                  <label className="block">Category{thread.categoryManual && <span className="ms-1 text-xs text-muted-foreground">(manual)</span>}
                    <select name="category" defaultValue={thread.category} className="mt-1 h-9 w-full rounded-md border bg-background px-2">{Object.entries(CATEGORY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                  <label className="block">Priority{thread.priorityManual && <span className="ms-1 text-xs text-muted-foreground">(manual)</span>}
                    <select name="priority" defaultValue={thread.priority} className="mt-1 h-9 w-full rounded-md border bg-background px-2">{["low", "normal", "high", "urgent"].map((v) => <option key={v} value={v}>{titleCase(v)}</option>)}</select></label>
                  <Button type="submit" size="sm" variant="outline">Save</Button>
                  <p className="text-xs text-muted-foreground">Manual choices are kept; the AI won&apos;t overwrite them.</p>
                </form>
              ) : <p className="text-sm text-muted-foreground">{CATEGORY_LABEL[thread.category]} · {titleCase(thread.priority)}</p>}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
