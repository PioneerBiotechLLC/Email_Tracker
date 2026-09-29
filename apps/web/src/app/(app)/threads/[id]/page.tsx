import Link from "next/link";
import { notFound } from "next/navigation";
import { classifyThread, closeThread, reopenThread, resummarizeThread, setNeedsReply } from "@/actions/thread";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmForm } from "@/components/shared/confirm-form";
import { CategoryChip, PriorityChip, StatusBadge } from "@/components/shared/badges";
import { getThreadDetail } from "@/lib/data/thread-detail";
import { CATEGORY_LABEL, formatDateTime, formatMinutes, formatSince, titleCase } from "@/lib/format";
import { getOrgContext } from "@/lib/org";
import { getSessionContext } from "@/lib/session";
import { cn } from "@/lib/utils";

const METHOD: Record<string, string> = { outlook_verb: "Outlook reply verb", header_match: "email headers", conversation_match: "conversation match" };

export default async function ThreadPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ai?: string; detail?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getSessionContext();
  const { org } = await getOrgContext(ctx.orgId);
  const data = await getThreadDetail(ctx, id);
  if (!data) notFound();
  const { thread, messages } = data;
  const tz = org.timezone;
  const now = new Date();
  const owners = new Set([thread.mailbox.emailAddress, ...thread.mailbox.aliases]);
  const isAdmin = ctx.role === "admin";
  const asks = Array.isArray(thread.asks) ? (thread.asks as { from: string; ask: string; due: string | null }[]) : [];
  const keyPoints = Array.isArray(thread.keyPoints) ? (thread.keyPoints as string[]) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/threads" className="text-sm text-muted-foreground hover:underline">← Threads</Link>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold" dir="auto">{thread.subject || "(no subject)"}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={thread.status} overdueAt={thread.overdueAt} now={now} />
            <CategoryChip category={thread.category} /><PriorityChip priority={thread.priority} />
            <span>{thread.mailbox.emailAddress} · {messages.length} messages</span>
            {thread.status === "awaiting_us" && thread.awaitingSince && <span>· waiting {formatSince(thread.awaitingSince, now)}</span>}
            {thread.status === "closed" && <span>· closed by {thread.closedBy === "ai" ? "the AI (concluded)" : thread.closedBy}</span>}
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-2" aria-label="Thread actions">
            {thread.status === "closed"
              ? <ConfirmForm action={reopenThread.bind(null, thread.id)} confirmText="Reopen this thread?">Reopen</ConfirmForm>
              : <ConfirmForm action={closeThread.bind(null, thread.id)} confirmText="Mark this thread as closed? A new inbound email will reopen it.">Mark closed</ConfirmForm>}
            {thread.needsReply
              ? <ConfirmForm action={setNeedsReply.bind(null, thread.id, false)} confirmText="Mark as 'no reply needed'? This stays until a new email arrives in the thread.">No reply needed</ConfirmForm>
              : <ConfirmForm action={setNeedsReply.bind(null, thread.id, true)} confirmText="Mark this thread as needing a reply?">Needs reply</ConfirmForm>}
            <ConfirmForm action={resummarizeThread.bind(null, thread.id)} confirmText="Re-summarize with Claude now? This uses one AI call (counts toward the daily cap).">Re-summarize</ConfirmForm>
          </div>
        )}
      </div>
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
              <article key={m.id} id={`msg-${m.id}`} className={cn("max-w-[92%] rounded-lg border p-3 text-sm", ours ? "self-end bg-primary/5 border-primary/20" : "self-start bg-card", m.isAutoReply && "opacity-60")}>
                <header className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground" dir="auto">{m.fromName || m.fromAddress}</span>
                  {m.fromName && <span>{m.fromAddress}</span>}
                  <span>· {formatDateTime(m.direction === "outbound" && m.sentAt ? m.sentAt : m.receivedAt, tz, now)}</span>
                  {m.isAutoReply && <span className="rounded bg-muted px-1">automatic reply</span>}
                  {m.hasAttachments && <span>· 📎</span>}
                </header>
                <div className="whitespace-pre-wrap break-words" dir="auto">{m.body || <span className="italic text-muted-foreground">(empty)</span>}</div>
                {!ours && !m.isAutoReply && (
                  <footer className="mt-2 border-t pt-1.5 text-xs text-muted-foreground">
                    {m.repliedAt ? (
                      <>Replied {formatDateTime(m.repliedAt, tz, now)} via {METHOD[m.replyMethod ?? ""] ?? "?"} · {formatMinutes(m.responseBusinessMinutes)} business ({formatMinutes(m.responseMinutes)} raw)
                        {m.repliedBy && <> · <a href={`#msg-${m.repliedBy.id}`} className="underline">see reply</a></>}</>
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
                    <dt>Updated</dt><dd>{formatDateTime(thread.summaryUpdatedAt, tz, now)}{thread.messageCount > thread.summaryMessageCount && " · new messages since"}</dd>
                    <dt>Model</dt><dd>{thread.summaryModel ?? "–"}</dd>
                  </dl>
                </>
              ) : thread.summaryError ? (
                <p className="text-status-bad">Summary failed: {thread.summaryError.replace(/^\S+\s/, "")}</p>
              ) : <p className="italic text-muted-foreground">Summary pending — it is generated a couple of minutes after the last message.</p>}
              {thread.summaryError && thread.summary && <p className="text-xs text-status-bad">Last attempt failed: {thread.summaryError.replace(/^\S+\s/, "").slice(0, 120)}</p>}
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
