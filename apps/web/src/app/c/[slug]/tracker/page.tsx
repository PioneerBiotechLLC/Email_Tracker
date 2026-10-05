import Link from "next/link";
import { Download } from "lucide-react";
import { domainOf, orgDomains, orgSettings, trackingStart } from "@email-tracker/core";
import { ignoreSender } from "@/actions/rules";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { CategoryChip, ExcludedBadge, PriorityChip, StatusBadge } from "@/components/shared/badges";
import { ExcludedToggle, FilterBar } from "@/components/shared/filter-bar";
import { IgnoreMenu } from "@/components/shared/ignore-menu";
import { RuleBanner } from "@/components/shared/rule-banner";
import { Pagination, SortLink } from "@/components/shared/pagination";
import { getTrackerPage } from "@/lib/data/tracker";
import { clampToTracking, parseFilters, withParams, type SearchParams } from "@/lib/filters";
import { formatDateTime, formatMinutes } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata = { title: "Inbox Tracker" };
export const maxDuration = 60; // the quick "ignore" actions re-apply the rules to stored mail
const STATUSES = [{ value: "replied", label: "Replied" }, { value: "waiting", label: "Awaiting reply" }, { value: "overdue", label: "Overdue" }, { value: "no_reply_needed", label: "No reply needed" }];
const METHOD: Record<string, string> = { outlook_verb: "verb", header_match: "header", conversation_match: "conversation" };

export default async function TrackerPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { ctx, org } = await getCompanyContext(slug);
  const base = `/c/${slug}`;
  const trackFrom = trackingStart(org);
  const f = clampToTracking(parseFilters(sp, org.timezone), trackFrom, org.timezone);
  const now = new Date();
  const { rows, total, pages } = await getTrackerPage(ctx, f, now);
  const tz = org.timezone;
  const isAdmin = ctx.role === "admin";
  const ownDomains = orgDomains(org);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const returnTo = `${base}/tracker${withParams(sp, {})}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Inbox Tracker</h1>
        {trackFrom && <p className="text-sm text-muted-foreground">Reply tracking starts {orgSettings(org.settings).trackRepliesFrom} (Settings)</p>}
        <Button asChild variant="outline" size="sm"><a href={`${base}/tracker/export` + withParams(sp, {})} download data-testid="export-csv"><Download className="size-4" /> Export CSV</a></Button>
      </div>
      <FilterBar statuses={STATUSES} extra={<ExcludedToggle />} />
      <RuleBanner orgId={org.id} rule={one(sp.rule)} affected={one(sp.affected)} returnTo={returnTo} />
      {rows.length === 0 ? (
        <EmptyState title="No emails in this range" hint="Try a wider date range or clear the filters." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {/* Phone: From, Subject and Status stay; the received time moves under the sender and the detail columns appear on wider screens. */}
                <TableHead className="hidden sm:table-cell"><SortLink col="receivedAt" label="Received" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead><SortLink col="fromAddress" label="From" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead><SortLink col="subject" label="Subject" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead className="hidden md:table-cell"><SortLink col="category" label="Category" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead className="hidden md:table-cell"><SortLink col="priority" label="Priority" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
                <TableHead className="hidden lg:table-cell"><SortLink col="repliedAt" label="Replied at" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead className="hidden lg:table-cell">Replied by</TableHead>
                <TableHead className="hidden text-right sm:table-cell"><SortLink col="responseBusinessMinutes" label="Response time" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                {isAdmin && <TableHead><span className="sr-only">Actions</span></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={cn(r.status === "overdue" && "row-overdue")} data-status={r.status}>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{formatDateTime(r.receivedAt, tz, now)}</TableCell>
                  <TableCell className="max-w-32 truncate sm:max-w-48" title={r.fromAddress}>{r.fromName ? <><span dir="auto">{r.fromName}</span><span className="block truncate text-xs text-muted-foreground">{r.fromAddress}</span></> : r.fromAddress}<span className="block text-xs text-muted-foreground sm:hidden">{formatDateTime(r.receivedAt, tz, now)}</span></TableCell>
                  <TableCell className="max-w-md whitespace-normal">
                    <Link href={`${base}/threads/${r.threadId}`} className="line-clamp-2 hover:underline" dir="auto">{r.subject || "(no subject)"}</Link>
                    {r.exclusionAction && <ExcludedBadge action={r.exclusionAction} reason={r.excludedReason} />}
                    <StatusBadge status={r.status} className="mt-1 sm:hidden" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell"><CategoryChip category={r.thread.category} /></TableCell>
                  <TableCell className="hidden md:table-cell"><PriorityChip priority={r.thread.priority} /></TableCell>
                  <TableCell className="hidden sm:table-cell"><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">{formatDateTime(r.repliedAt, tz, now)}</TableCell>
                  <TableCell className="hidden max-w-40 truncate text-xs lg:table-cell">{r.repliedByAddress ?? "–"}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-right sm:table-cell">
                    {r.repliedAt ? (
                      <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{formatMinutes(r.responseBusinessMinutes)}</span></TooltipTrigger><TooltipContent>Wall-clock: {formatMinutes(r.responseMinutes)}</TooltipContent></Tooltip>
                    ) : "–"}
                    {r.replyMethod && <span className="block text-[11px] text-muted-foreground">{METHOD[r.replyMethod] ?? r.replyMethod}</span>}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="w-8 p-1">
                      {r.exclusionAction !== "ignore" && domainOf(r.fromAddress) && !ownDomains.has(domainOf(r.fromAddress)) && (
                        <IgnoreMenu address={r.fromAddress} domain={domainOf(r.fromAddress)} ignoreSender={ignoreSender.bind(null, org.id, r.id, "sender_email", returnTo)} ignoreDomain={ignoreSender.bind(null, org.id, r.id, "sender_domain", returnTo)} />
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pagination page={f.page} pages={pages} total={total} sp={sp} label="emails" />
    </div>
  );
}
