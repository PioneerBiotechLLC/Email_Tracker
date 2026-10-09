import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { MAX_TURNS_PER_SESSION, trackingStart } from "@email-tracker/core";
import { AskBox } from "@/components/ask/ask-box";
import { AwaitingByCategoryChart, ReceivedVsRepliedChart, ResponseTimeChart } from "@/components/charts/overview-charts";
import { PriorityChip } from "@/components/shared/badges";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { chatEnabled } from "@/lib/chat-flag";
import { defaultAskRange } from "@/lib/data/ask";
import { getOverview } from "@/lib/data/overview";
import { clampToTracking, parseFilters, withParams, type SearchParams } from "@/lib/filters";
import { CATEGORY_LABEL, formatDateTime, formatMinutes, formatPct, formatSince } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata = { title: "Overview" };

/** One figure of the key-figures strip. With `href` the whole tile opens the matching list. */
function Stat({ label, value, sub, href, tone, tooltip, className }: { label: string; value: string; sub?: string; href?: string; tone?: "bad"; tooltip?: string; className?: string }) {
  const body = (
    <div className={cn("min-w-0 px-4 py-4 md:px-5", href && "press h-full transition-colors hover:bg-accent/50")}>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 font-sans text-2xl font-semibold tracking-tight md:text-[1.75rem]", tone === "bad" && "text-status-bad")}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
  const tile = href ? <Link href={href} className="block h-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">{body}</Link> : body;
  return (
    <div className={cn("bg-card", className)}>
      {tooltip ? <Tooltip><TooltipTrigger asChild><div tabIndex={0} className="h-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">{tile}</div></TooltipTrigger><TooltipContent>{tooltip}</TooltipContent></Tooltip> : tile}
    </div>
  );
}

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const [{ ctx, org, mailboxes }, chat] = await Promise.all([getCompanyContext(slug), chatEnabled()]);
  const base = `/c/${slug}`;
  const trackFrom = trackingStart(org);
  const f = clampToTracking(parseFilters(sp, org.timezone), trackFrom, org.timezone);
  const now = new Date();
  const o = await getOverview(ctx, f, org.timezone, now, trackFrom);
  const k = o.kpis;
  const chartData = o.days.map((d) => ({ ...d }));
  const byCategory = o.byCategory.map((c) => ({ category: CATEGORY_LABEL[c.category] ?? c.category, count: c.count }));
  const threadsHref = (status: string) => `${base}/threads` + withParams(sp, { status, page: null });
  const mailbox = f.mailboxId ? mailboxes.find((m) => m.id === f.mailboxId) : null;
  const askRange = defaultAskRange(now, org.timezone);
  const empty = k.received === 0 && o.awaiting === 0;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {f.fromDay} → {f.toDay}{trackFrom && f.from.getTime() === trackFrom.getTime() ? " · reply tracking starts here" : ""}{mailbox ? ` · ${mailbox.emailAddress}` : ""}{sp.denied ? " · Settings are admin-only" : ""}
          </p>
        </div>
        <Button asChild variant="outline" size="sm"><Link href={`${base}/summary` + withParams(sp, { range: null, from: null, to: null, page: null, denied: null })}><Sparkles className="size-4" /> Daily / weekly summary</Link></Button>
      </header>

      <section aria-label="Key figures" className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-sm md:grid-cols-5">
        <Stat label="Received" value={k.received.toLocaleString("en-US")} sub="inbound emails in range" />
        <Stat label="Replied" value={formatPct(k.repliedPct)} sub={`${k.replied.toLocaleString("en-US")} of ${k.received.toLocaleString("en-US")}`} />
        <Stat label="Average response" value={formatMinutes(k.avgBusinessMinutes)} sub="business hours" tooltip={`Wall-clock average: ${formatMinutes(k.avgRawMinutes)}`} />
        <Stat label="Awaiting reply" value={o.awaiting.toLocaleString("en-US")} sub="threads, right now" href={threadsHref("awaiting_us")} />
        <Stat label="Overdue" value={o.overdue.toLocaleString("en-US")} sub={o.overdue ? "past the SLA · open the list" : "past the SLA"} href={threadsHref("overdue")} tone={o.overdue ? "bad" : undefined} className="col-span-2 md:col-span-1" />
      </section>

      {chat && (
        <AskBox
          slug={slug}
          orgId={org.id}
          scope={{ mailboxId: mailbox?.id ?? null, mailboxLabel: mailbox ? mailbox.emailAddress : "all mailboxes", after: askRange.after, before: askRange.before }}
          maxTurns={MAX_TURNS_PER_SESSION}
        />
      )}

      {empty ? (
        <EmptyState title="No emails in this range" hint="Change the date range or mailbox, or run pnpm sync:once to pull mail." />
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-3" aria-label="Backlog">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Needs attention</CardTitle>
                <CardDescription>{o.overdue ? `${o.overdue.toLocaleString("en-US")} ${o.overdue === 1 ? "thread is" : "threads are"} past the reply SLA · oldest first` : "Threads past the reply SLA"}</CardDescription>
                {o.overdue > 0 && <CardAction><Link href={threadsHref("overdue")} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground hover:underline">All overdue threads <ArrowRight className="size-3.5" aria-hidden /></Link></CardAction>}
              </CardHeader>
              <CardContent>
                {o.attention.length ? (
                  <ul className="divide-y">
                    {o.attention.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                        <Link href={`${base}/threads/${t.id}`} className="min-w-0 flex-1 basis-56 truncate font-medium hover:underline" dir="auto">{t.subject || "(no subject)"}</Link>
                        <PriorityChip priority={t.priority} />
                        <span className="text-xs text-muted-foreground"><span className="font-medium text-status-bad" title={`Waiting since ${formatDateTime(t.awaitingSince, org.timezone, now)}`}>waiting {formatSince(t.awaitingSince, now)}</span> · {t.mailbox.emailAddress}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted-foreground">Nothing is overdue. 🎉</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Awaiting reply by category</CardTitle>
                <CardDescription>{o.awaiting ? `${o.awaiting.toLocaleString("en-US")} ${o.awaiting === 1 ? "thread waits" : "threads wait"} for our reply` : "Threads waiting for our reply"}</CardDescription>
              </CardHeader>
              <CardContent>{byCategory.length ? <AwaitingByCategoryChart data={byCategory} /> : <p className="text-sm text-muted-foreground">Nothing is waiting for a reply.</p>}</CardContent>
            </Card>
          </section>

          <section className="grid gap-4 lg:grid-cols-2" aria-label="Trends">
            <Card>
              <CardHeader><CardTitle className="text-base">Received vs replied per day</CardTitle><CardDescription>Inbound emails and how many of them got a reply</CardDescription></CardHeader>
              <CardContent><ReceivedVsRepliedChart data={chartData} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Response time per day</CardTitle><CardDescription>Median of the day&apos;s answered emails, in business hours</CardDescription></CardHeader>
              <CardContent><ResponseTimeChart data={chartData} /></CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
