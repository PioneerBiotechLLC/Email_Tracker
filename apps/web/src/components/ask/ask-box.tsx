"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, MessageCircleQuestion, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AskTurn } from "@/lib/data/ask";
import { Turn } from "./ask-chat";
import { streamAsk } from "./ask-stream";

export interface AskBoxProps {
  slug: string;
  orgId: string;
  /** What a question searches: the mailbox picked in the top bar (null = all) and the dates the Ask page uses by default (YYYY-MM-DD). */
  scope: { mailboxId: string | null; mailboxLabel: string; after: string; before: string };
  maxTurns: number;
}

/**
 * The Ask chat in one card for the overview: a question, its answer with sources, and follow-ups
 * in the same chat. Filters, the deep model and chat history stay on the Ask page.
 */
export function AskBox({ slug, orgId, scope, maxTurns }: AskBoxProps) {
  const base = `/c/${slug}/ask`;
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pending, setPending] = useState<{ question: string; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const full = turns.length >= maxTurns;
  const chatHref = sessionId ? `${base}?s=${sessionId}` : base;

  async function ask() {
    const q = question.trim();
    if (!q || pending || full) return;
    setError(null);
    setPending({ question: q, status: "Thinking…" });
    setQuestion("");
    try {
      const r = await streamAsk(base, { question: q, sessionId, deep: false, mailboxId: scope.mailboxId, after: scope.after || null, before: scope.before || null, threadId: null }, (status) => setPending({ question: q, status }));
      if (!r.ok) {
        setError(r.message);
        setQuestion(q);
        return;
      }
      setTurns((t) => [...t, r.turn]);
      setSessionId(r.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The question could not be sent.");
      setQuestion(q);
    } finally {
      setPending(null);
    }
  }

  return (
    <section aria-labelledby="ask-box-title" className="rounded-xl border bg-card text-card-foreground shadow-sm" data-testid="ask-box">
      <form className="space-y-3 p-4 md:p-5" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="ask-box-title" className="flex items-center gap-2 font-heading text-base font-semibold"><MessageCircleQuestion className="size-4 text-primary" aria-hidden /> Ask about your email</h2>
          <Link href={chatHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline" data-testid="ask-box-open">{sessionId ? "Continue in Ask" : "Open Ask"} <ArrowRight className="size-3.5" aria-hidden /></Link>
        </div>
        {full ? (
          <p className="text-sm text-muted-foreground">This chat reached {maxTurns} questions. <Link href={chatHref} className="underline">Continue in Ask</Link>, or reload the page to start a new one.</p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea ref={input} value={question} onChange={(e) => setQuestion(e.target.value)} rows={1} maxLength={2000} dir="auto" aria-label="Your question"
              placeholder="Ask a question…"
              className="min-h-11 flex-1 resize-none rounded-md border bg-background px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(); } }} />
            <Button type="submit" disabled={!!pending || !question.trim()}><Send /> {pending ? "Asking…" : "Ask"}</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          For example &quot;What happened to PO 4512?&quot; · Searches {scope.mailboxLabel} from {scope.after} to {scope.before}. Answers come only from stored emails and link to the emails they rely on. Other dates, one thread, or a deeper model: <Link href={base} className="underline">open Ask</Link>.
        </p>
      </form>
      {(turns.length > 0 || pending || error) && (
        <div className="space-y-5 border-t p-4 md:p-5" aria-live="polite">
          {turns.map((t) => <Turn key={t.id} turn={t} slug={slug} orgId={orgId} />)}
          {pending && (
            <div className="space-y-3">
              <div className="flex justify-end"><p className="max-w-[85%] rounded-lg bg-primary/10 px-3 py-2 text-sm" dir="auto">{pending.question}</p></div>
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="ask-status"><span className="size-2 animate-pulse rounded-full bg-primary" aria-hidden />{pending.status}</p>
            </div>
          )}
          {error && <p className="rounded-md border px-3 py-2 text-sm status-overdue" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
