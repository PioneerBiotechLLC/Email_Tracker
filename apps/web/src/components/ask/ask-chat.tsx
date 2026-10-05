"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Copy, ExternalLink, History, Plus, Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { setTurnFeedback } from "@/actions/ask";
import { Button } from "@/components/ui/button";
import type { AskStreamEvent, AskTurn } from "@/lib/data/ask";
import { cn } from "@/lib/utils";
import { AnswerText } from "./answer-text";

export interface AskChatProps {
  slug: string;
  orgId: string;
  sessions: { id: string; title: string; when: string }[];
  session: { id: string; turns: AskTurn[] } | null;
  mailboxes: { id: string; emailAddress: string }[];
  /** "Ask about this thread": the question is limited to one thread */
  thread: { id: string; subject: string } | null;
  initialQuestion: string;
  models: { chat: string; deep: string; deepCostFactor: number };
  maxTurns: number;
  /** pre-filled From / to dates (YYYY-MM-DD); empty when asking about one thread */
  defaultRange: { after: string; before: string };
}

const field = "h-9 rounded-md border bg-background px-2 text-sm";
const usd = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

function Turn({ turn, slug, orgId }: { turn: AskTurn; slug: string; orgId: string }) {
  const [helpful, setHelpful] = useState(turn.helpful);
  const [copied, setCopied] = useState(false);
  const [, start] = useTransition();
  const anchor = (marker: string) => `src-${turn.id}-${marker}`;
  const rate = (value: boolean) => {
    const next = helpful === value ? null : value;
    setHelpful(next);
    start(() => setTurnFeedback(orgId, turn.id, next));
  };
  return (
    <article className="space-y-3" data-testid="ask-turn">
      <div className="flex justify-end"><p className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-sm" dir="auto">{turn.question}</p></div>
      <div className="max-w-[92%] space-y-3 rounded-lg border bg-card p-3 text-sm">
        {turn.error
          ? <p className="text-status-bad" role="alert">{turn.answerMarkdown}</p>
          : <AnswerText markdown={turn.answerMarkdown} markers={turn.citations.map((c) => c.marker)} anchor={anchor} />}
        {turn.unverified && <p className="rounded border px-2 py-1 text-xs status-waiting" role="note">Unverified: none of this answer&apos;s sources could be confirmed against the emails that were read. Check before relying on it.</p>}
        {turn.limitHit && <p className="text-xs text-muted-foreground" role="note">The search was cut short ({turn.limitHit === "tool_calls" ? "search limit per question" : turn.limitHit === "time" ? "time limit" : "reading budget"}). Ask a narrower question for a fuller answer.</p>}
        {turn.citations.length > 0 && (
          <div>
            <h3 className="mb-1 font-sans text-xs font-semibold uppercase text-muted-foreground">Sources</h3>
            <ol className="space-y-1.5">
              {turn.citations.map((c) => (
                <li key={c.marker} id={anchor(c.marker)} className="flex gap-2 rounded px-1 text-xs target:bg-primary/10" data-testid="ask-source">
                  <span className="mt-0.5 inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">{c.marker}</span>
                  <span className="min-w-0">
                    <span className="block truncate" dir="auto"><span className="font-medium">{c.from}</span> → {c.to || "?"} · {c.subject || "(no subject)"}</span>
                    <span className="text-muted-foreground">{c.date} · {c.mailbox} · </span>
                    {/* A plain link (full navigation): the browser then scrolls to the email and :target highlights it. */}
                    <a href={`/c/${slug}/threads/${c.threadId}#msg-${c.messageId}`} className="underline">Open thread</a>
                    {c.webLink && <> · <a href={c.webLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline">Open in Outlook <ExternalLink className="size-3" aria-hidden /></a></>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs text-muted-foreground">
          <span>{turn.model}</span><span>{usd(turn.costUsd)}</span><span>{turn.emailsRead} email{turn.emailsRead === 1 ? "" : "s"} read</span>
          <span className="ms-auto flex items-center gap-1">
            <Button type="button" variant="ghost" size="icon-xs" aria-label="Copy answer" onClick={() => { void navigator.clipboard.writeText(turn.answerMarkdown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check /> : <Copy />}</Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="This answer helped" aria-pressed={helpful === true} className={cn(helpful === true && "text-status-ok")} onClick={() => rate(true)}><ThumbsUp /></Button>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="This answer did not help" aria-pressed={helpful === false} className={cn(helpful === false && "text-status-bad")} onClick={() => rate(false)}><ThumbsDown /></Button>
          </span>
        </footer>
      </div>
    </article>
  );
}

export function AskChat({ slug, orgId, sessions, session, mailboxes, thread, initialQuestion, models, maxTurns, defaultRange }: AskChatProps) {
  const router = useRouter();
  const base = `/c/${slug}/ask`;
  const [turns, setTurns] = useState<AskTurn[]>(session?.turns ?? []);
  const [sessionId, setSessionId] = useState<string | null>(session?.id ?? null);
  const [question, setQuestion] = useState(initialQuestion);
  const [pending, setPending] = useState<{ question: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ mailboxId: "", ...defaultRange, deep: false });
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const full = turns.length >= maxTurns;
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [turns.length, pending?.status]);

  async function ask() {
    const q = question.trim();
    if (!q || pending || full) return;
    setError(null);
    setPending({ question: q, status: "Thinking…" });
    setQuestion("");
    try {
      const res = await fetch(`${base}/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, sessionId, deep: filters.deep, mailboxId: filters.mailboxId || null, after: filters.after || null, before: filters.before || null, threadId: thread?.id ?? null }) });
      if (!res.ok || !res.body) throw new Error(`The server answered ${res.status}.`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        buffer += value ?? "";
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const e = JSON.parse(line) as AskStreamEvent;
          if (e.type === "status") setPending({ question: q, status: e.text });
          else if (e.type === "error") { setError(e.message); setQuestion(q); }
          else {
            setTurns((t) => [...t, e.turn]);
            if (e.sessionId !== sessionId) {
              setSessionId(e.sessionId);
              // Keep the URL on this chat so a reload (and the history list) shows it.
              router.replace(`${base}?s=${e.sessionId}${thread ? `&thread=${thread.id}` : ""}`, { scroll: false });
            }
          }
        }
        if (done) break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The question could not be sent.");
      setQuestion(q);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-4 md:grid-cols-[240px_1fr]">
      <aside aria-label="Chat history" className="md:border-e md:pe-4">
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="flex-1"><Link href={base}><Plus /> New chat</Link></Button>
          <Button type="button" variant="outline" size="sm" className="md:hidden" aria-expanded={historyOpen} aria-controls="ask-history" onClick={() => setHistoryOpen((o) => !o)}><History /> History ({sessions.length})</Button>
        </div>
        <ul id="ask-history" className={cn("mt-3 space-y-1 text-sm md:block", historyOpen ? "block" : "hidden")}>
          {sessions.map((s) => (
            <li key={s.id}>
              <Link href={`${base}?s=${s.id}`} aria-current={s.id === sessionId ? "page" : undefined} className={cn("block rounded-md px-2 py-1.5 hover:bg-accent", s.id === sessionId && "bg-accent font-medium")}>
                <span className="block truncate" dir="auto">{s.title}</span><span className="text-xs text-muted-foreground">{s.when}</span>
              </Link>
            </li>
          ))}
          {!sessions.length && <li className="px-2 text-muted-foreground">No chats yet. Only you can see your chats.</li>}
        </ul>
      </aside>

      <section aria-label="Chat" className="flex min-h-[60vh] min-w-0 flex-col gap-4">
        <div className="flex-1 space-y-5" aria-live="polite">
          {!turns.length && !pending && (
            <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Ask about your company&apos;s email</p>
              <p className="mt-1">For example: &quot;What happened to shipment 4512?&quot; or &quot;Latest update from supplier X about excipient Y?&quot;. Answers are short, come only from stored emails, and link to the exact emails they rely on.</p>
            </div>
          )}
          {turns.map((t) => <Turn key={t.id} turn={t} slug={slug} orgId={orgId} />)}
          {pending && (
            <div className="space-y-3">
              <div className="flex justify-end"><p className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-sm" dir="auto">{pending.question}</p></div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="ask-status"><span className="size-2 animate-pulse rounded-full bg-primary" aria-hidden />{pending.status}</p>
            </div>
          )}
          {error && <p className="rounded-md border px-3 py-2 text-sm status-overdue" role="alert">{error}</p>}
          <div ref={bottom} />
        </div>

        <form className="sticky bottom-0 space-y-2 rounded-lg border bg-card p-3" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          {thread && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate" dir="auto">Limited to the thread: <strong>{thread.subject || "(no subject)"}</strong></span>
              <Link href={sessionId ? `${base}?s=${sessionId}` : base} aria-label="Remove the thread limit" className="rounded p-0.5 hover:bg-accent"><X className="size-3" /></Link>
            </p>
          )}
          {full ? (
            <p className="text-sm text-muted-foreground">This chat reached {maxTurns} questions. <Link href={base} className="underline">Start a new chat</Link> to continue.</p>
          ) : (
            <div className="flex items-end gap-2">
              <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} maxLength={2000} dir="auto" aria-label="Your question" placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)" className="min-h-[2.75rem] flex-1 resize-y rounded-md border bg-background p-2 text-sm"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(); } }} />
              <Button type="submit" disabled={!!pending || !question.trim()}><Send /> {pending ? "Asking…" : "Ask"}</Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <select aria-label="Mailbox" className={field} value={filters.mailboxId} onChange={(e) => setFilters({ ...filters, mailboxId: e.target.value })}>
              <option value="">All mailboxes</option>
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress}</option>)}
            </select>
            <label className="flex items-center gap-1">From<input type="date" className={field} value={filters.after} onChange={(e) => setFilters({ ...filters, after: e.target.value })} /></label>
            <label className="flex items-center gap-1">to<input type="date" className={field} value={filters.before} onChange={(e) => setFilters({ ...filters, before: e.target.value })} /></label>
            <label className="flex items-center gap-1.5" title={`Uses ${models.deep} instead of ${models.chat}`}>
              <input type="checkbox" checked={filters.deep} onChange={(e) => setFilters({ ...filters, deep: e.target.checked })} />
              Deep answer ({models.deep}, about {models.deepCostFactor}× the cost)
            </label>
          </div>
        </form>
      </section>
    </div>
  );
}
