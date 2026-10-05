import Link from "next/link";
import { trackingStart } from "@email-tracker/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AwaitingByCategoryChart, ReceivedVsRepliedChart, ResponseTimeChart } from "@/components/charts/overview-charts";
import { EmptyState } from "@/components/shared/empty-state";
import { PriorityChip, StatusBadge } from "@/components/shared/badges";
import { getOverview } from "@/lib/data/overview";
import { clampToTracking, parseFilters, withParams, type SearchParams } from "@/lib/filters";
import { CATEGORY_LABEL, formatDateTime, formatMinutes, formatPct, formatSince } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";

export const metadata = { title: "Overview" };

function Tile({ label, value, sub, tooltip }: { label: string; value: string; sub?: string; tooltip?: string }) {
  const body = (
    <Card className="gap-1 py-4">
      <CardHeader className="px-4"><CardTitle className="font-sans text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle></CardHeader>
      <CardContent className="px-4"><div className="font-heading text-2xl font-bold">{value}</div>{sub && <div className="text-xs text-muted-foreground">{sub}</div>}</CardContent>
    </Card>
  );
  return tooltip ? <Tooltip><TooltipTrigger asChild><div tabIndex={0}>{body}</div></TooltipTrigger><TooltipContent>{tooltip}</TooltipContent></Tooltip> : body;
}

export default async function OverviewPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { ctx, org } = await getCompanyContext(slug);
  const base = `/c/${slug}`;
  const trackFrom = trackingStart(org);
  const f = clampToTracking(parseFilters(sp, org.timezone), trackFrom, org.timezone);
  const now = new Date();
  const o = await getOverview(ctx, f, org.timezone, now);
  const k = o.kpis;
  const chartData = o.days.map((d) => ({ ...d }));
  const byCategory = o.byCategory.map((c) => ({ category: CATEGORY_LABEL[c.category] ?? c.category, count: c.count }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          {f.fromDay} → {f.toDay}{trackFrom && f.from.getTime() === trackFrom.getTime() ? " (reply tracking starts here)" : ""}{sp.denied ? " · Settings are admin-only" : ""} · <Link href={`${base}/summary` + withParams(sp, { range: null, from: null, to: null, page: null, denied: null })} className="underline">Daily / weekly summary</Link>
        </p>
      </div>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" aria-label="Key figures">
        <Tile label="Received" value={k.received.toLocaleString("en-US")} sub="inbound emails in range" />
        <Tile label="Replied" value={formatPct(k.repliedPct)} sub={`${k.replied} of ${k.received}`} />
        <Tile label="Median response" value={formatMinutes(k.medianBusinessMinutes)} sub="business hours" tooltip={`Wall-clock median: ${formatMinutes(k.medianRawMinutes)}`} />
        <Tile label="Average response" value={formatMinutes(k.avgBusinessMinutes)} sub="business hours" tooltip={`Wall-clock average: ${formatMinutes(k.avgRawMinutes)}`} />
        <Tile label="Awaiting reply" value={o.awaiting.toLocaleString("en-US")} sub="threads, right now" />
        <Tile label="Overdue" value={o.overdue.toLocaleString("en-US")} sub="past the SLA" />
      </section>

      {k.received === 0 && o.awaiting === 0 ? (
        <EmptyState title="No emails in this range" hint="Change the date range or mailbox, or run pnpm sync:once to pull mail." />
      ) : (
        <>
          <section className="grid gap-4 lg:grid-cols-2">
            <Card><CardHeader><CardTitle className="text-base">Received vs replied per day</CardTitle></CardHeader><CardContent><ReceivedVsRepliedChart data={chartData} /></CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Median response time per day (business hours)</CardTitle></CardHeader><CardContent><ResponseTimeChart data={chartData} /></CardContent></Card>
          </section>
          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Awaiting reply by category</CardTitle></CardHeader>
              <CardContent>{byCategory.length ? <AwaitingByCategoryChart data={byCategory} /> : <p className="text-sm text-muted-foreground">Nothing is waiting for a reply.</p>}</CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Slowest-answered senders</CardTitle></CardHeader>
              <CardContent>
                {o.slowest.length ? (
                  <table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 font-medium">Company / sender</th><th className="py-1 text-right font-medium">Replies</th><th className="py-1 text-right font-medium">Avg (business)</th><th className="py-1 text-right font-medium">Median</th></tr></thead>
                    <tbody>{o.slowest.map((s) => <tr key={s.key} className="border-t"><td className="py-1.5">{s.key}</td><td className="py-1.5 text-right">{s.replies}</td><td className="py-1.5 text-right">{formatMinutes(s.avgBusinessMinutes)}</td><td className="py-1.5 text-right">{formatMinutes(s.medianBusinessMinutes)}</td></tr>)}</tbody></table>
                ) : <p className="text-sm text-muted-foreground">Not enough answered emails yet (needs 2+ replies per sender).</p>}
              </CardContent>
            </Card>
          </section>
        </>
      )}

      <section>
        <Card>
          <CardHeader className="flex-row items-baseline justify-between"><CardTitle className="text-base">Needs attention</CardTitle><Link href={`${base}/threads` + withParams(sp, { status: "overdue", page: null })} className="text-sm underline">All overdue threads</Link></CardHeader>
          <CardContent>
            {o.attention.length ? (
              <ul className="divide-y">
                {o.attention.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                    <StatusBadge status="overdue" />
                    <Link href={`${base}/threads/${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline" dir="auto">{t.subject || "(no subject)"}</Link>
                    <PriorityChip priority={t.priority} />
                    <span className="text-xs text-muted-foreground">waiting {formatSince(t.awaitingSince, now)} · since {formatDateTime(t.awaitingSince, org.timezone, now)} · {t.mailbox.emailAddress}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">Nothing is overdue. 🎉</p>}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
