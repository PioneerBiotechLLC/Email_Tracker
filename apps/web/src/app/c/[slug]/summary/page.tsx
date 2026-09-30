import Link from "next/link";
import { Sparkles } from "lucide-react";
import { isSummaryPeriod, PERIOD_LABEL, SUMMARY_PERIODS } from "@email-tracker/core";
import { generatePeriodSummary } from "@/actions/summary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ActionButton } from "@/components/shared/action-button";
import { getPeriodSummaryPage } from "@/lib/data/summary";
import { parseFilters, withParams, type SearchParams } from "@/lib/filters";
import { formatDate, formatDateTime, formatPct, formatUsd } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata = { title: "Summary" };

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4"><CardTitle className="font-sans text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent className="px-4"><div className="font-heading text-2xl font-bold">{value}</div>{sub && <div className="text-xs text-muted-foreground">{sub}</div>}</CardContent>
    </Card>
  );
}

function Bullets({ title, items, empty }: { title: string; items: unknown; empty: string }) {
  const list = Array.isArray(items) ? (items as string[]) : [];
  return (
    <div>
      <h3 className="mb-1 font-sans text-xs font-semibold uppercase text-muted-foreground">{title}</h3>
      {list.length ? <ul className="list-disc space-y-1 ps-5" dir="auto">{list.map((k, i) => <li key={i}>{k}</li>)}</ul> : <p className="text-sm text-muted-foreground">{empty}</p>}
    </div>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SummaryPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { ctx, org, mailboxes } = await getCompanyContext(slug);
  const base = `/c/${slug}`;
  const f = parseFilters(sp, org.timezone);
  const mailboxId = f.mailboxId && mailboxes.some((m) => m.id === f.mailboxId) ? f.mailboxId : null;
  const periodRaw = one(sp.period);
  const period = isSummaryPeriod(periodRaw) ? periodRaw : "week";
  const now = new Date();
  const tz = org.timezone;
  const { range, stats, latest, aiConfigured } = await getPeriodSummaryPage(ctx, mailboxId, period, tz, now);
  const scope = mailboxId ? mailboxes.find((m) => m.id === mailboxId)!.emailAddress : `all mailboxes (${mailboxes.length})`;
  const ai = one(sp.ai);
  const detail = one(sp.detail);
  const isCurrent = latest && latest.periodStart.getTime() === range.from.getTime();
  const noActivity = stats.threads === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Summary</h1>
          <p className="text-sm text-muted-foreground">{scope} · {range.label} · {formatDate(range.from, tz, now)} → {formatDate(range.to, tz, now)}</p>
        </div>
        <div className="flex items-center rounded-md border bg-background p-0.5" role="group" aria-label="Period">
          {SUMMARY_PERIODS.map((p) => (
            <Link key={p} href={`${base}/summary` + withParams(sp, { period: p, ai: null, detail: null, page: null })} aria-current={p === period ? "page" : undefined}
              className={cn("rounded px-2.5 py-1 text-sm", p === period ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
              {PERIOD_LABEL[p]}
            </Link>
          ))}
        </div>
      </div>

      {ai && (
        <div className={cn("rounded-md border px-3 py-2 text-sm", ai === "summarized" ? "status-replied" : "status-waiting")} role="status">
          {ai === "summarized" ? `Digest generated (${detail}).` : ai === "skipped" && detail === "no_activity" ? "Nothing to summarize: no emails in this period." : ai === "skipped" && detail === "cap_reached" ? "Not generated: the daily AI call cap is reached. Try again tomorrow." : `Not generated: ${ai}${detail ? ` — ${detail}` : ""}.`}
        </div>
      )}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" aria-label="Figures for the period">
        <Tile label="Received" value={stats.received.toLocaleString("en-US")} sub="inbound emails" />
        <Tile label="Sent" value={stats.sent.toLocaleString("en-US")} sub="outbound emails" />
        <Tile label="Answered" value={formatPct(stats.repliedPct)} sub={`${stats.replied} of ${stats.received}`} />
        <Tile label="Awaiting reply" value={stats.awaiting.toLocaleString("en-US")} sub="threads active in period" />
        <Tile label="Overdue" value={stats.overdue.toLocaleString("en-US")} sub="past the SLA" />
        <Tile label="Threads" value={stats.threads.toLocaleString("en-US")} sub={mailboxId ? "in this mailbox" : `across ${stats.mailboxes} mailbox${stats.mailboxes === 1 ? "" : "es"}`} />
      </section>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="size-4" aria-hidden /> AI digest — {range.label}</CardTitle>
          <ActionButton action={generatePeriodSummary.bind(null, org.id, mailboxId, period)} pendingLabel="Summarizing…" disabled={!aiConfigured || noActivity} testId="generate-summary"
            title={!aiConfigured ? "ANTHROPIC_API_KEY is not set" : noActivity ? "No emails in this period" : "Uses one AI call (counts toward the daily cap)"}>
            {latest ? "Regenerate" : "Generate summary"}
          </ActionButton>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {latest ? (
            <>
              {!isCurrent && <p className="rounded-md border px-3 py-2 text-xs text-muted-foreground">This digest covers {formatDate(latest.periodStart, tz, now)} → {formatDate(latest.periodEnd, tz, now)}. Regenerate to cover the current window.</p>}
              <p className="text-base" dir="auto" data-testid="digest-overview">{latest.overview}</p>
              <div className="grid gap-4 md:grid-cols-3">
                <Bullets title="Received" items={latest.received} empty="Nothing notable came in." />
                <Bullets title="Sent" items={latest.sent} empty="Nothing notable was sent." />
                <Bullets title="Needs attention" items={latest.needsAttention} empty="Nothing is waiting for our reply. 🎉" />
              </div>
              <p className="text-xs text-muted-foreground">
                Generated {formatDateTime(latest.createdAt, tz, now)}{latest.createdBy ? ` by ${latest.createdBy}` : ""} · {latest.threadCount} thread{latest.threadCount === 1 ? "" : "s"} in period{latest.includedCount < latest.threadCount ? ` (${latest.includedCount} shown to the model)` : ""} · {latest.model} · {formatUsd(latest.costUsd)}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground" dir="auto">
              {noActivity ? "No emails in this period." : !aiConfigured ? "Set ANTHROPIC_API_KEY to generate digests." : `No digest yet for ${scope} · ${range.label.toLowerCase()}. Click "Generate summary" for a very short overview of what was received, what was sent and what still needs a reply.`}
            </p>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Figures are computed from the database; only the text is written by the AI. Across all mailboxes an email that several mailboxes received (for example when one was Cc&apos;d) is counted once.
        Change the mailbox in the top bar. <Link href={`${base}/threads` + withParams(sp, { period: null, ai: null, detail: null, range: period === "day" ? "7d" : period === "week" ? "7d" : "30d" })} className="underline">Open the threads for this period</Link>.
      </p>
    </div>
  );
}
