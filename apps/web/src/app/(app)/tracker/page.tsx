import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { CategoryChip, PriorityChip, StatusBadge } from "@/components/shared/badges";
import { FilterBar } from "@/components/shared/filter-bar";
import { Pagination, SortLink } from "@/components/shared/pagination";
import { getTrackerPage } from "@/lib/data/tracker";
import { parseFilters, withParams, type SearchParams } from "@/lib/filters";
import { formatDateTime, formatMinutes } from "@/lib/format";
import { getOrgContext } from "@/lib/org";
import { getSessionContext } from "@/lib/session";
import { cn } from "@/lib/utils";

export const metadata = { title: "Inbox Tracker" };
const STATUSES = [{ value: "replied", label: "Replied" }, { value: "waiting", label: "Waiting" }, { value: "overdue", label: "Overdue" }, { value: "no_reply_needed", label: "No reply needed" }];
const METHOD: Record<string, string> = { outlook_verb: "verb", header_match: "header", conversation_match: "conversation" };

export default async function TrackerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getSessionContext();
  const { org } = await getOrgContext(ctx.orgId);
  const f = parseFilters(sp, org.timezone);
  const now = new Date();
  const { rows, total, pages } = await getTrackerPage(ctx, f, now);
  const tz = org.timezone;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Inbox Tracker</h1>
        <Button asChild variant="outline" size="sm"><a href={"/tracker/export" + withParams(sp, {})} download data-testid="export-csv"><Download className="size-4" /> Export CSV</a></Button>
      </div>
      <FilterBar statuses={STATUSES} />
      {rows.length === 0 ? (
        <EmptyState title="No emails in this range" hint="Try a wider date range or clear the filters." />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead><SortLink col="receivedAt" label="Received" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead><SortLink col="fromAddress" label="From" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead><SortLink col="subject" label="Subject" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead><SortLink col="category" label="Category" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead><SortLink col="priority" label="Priority" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead>Status</TableHead>
                <TableHead><SortLink col="repliedAt" label="Replied at" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
                <TableHead>Replied by</TableHead>
                <TableHead className="text-right"><SortLink col="responseBusinessMinutes" label="Response time" sp={sp} current={f.sort} dir={f.dir} /></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className={cn(r.status === "overdue" && "row-overdue")} data-status={r.status}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.receivedAt, tz, now)}</TableCell>
                  <TableCell className="max-w-48 truncate" title={r.fromAddress}>{r.fromName ? <><span dir="auto">{r.fromName}</span><span className="block truncate text-xs text-muted-foreground">{r.fromAddress}</span></> : r.fromAddress}</TableCell>
                  <TableCell className="max-w-md"><Link href={`/threads/${r.threadId}`} className="line-clamp-2 hover:underline" dir="auto">{r.subject || "(no subject)"}</Link></TableCell>
                  <TableCell><CategoryChip category={r.thread.category} /></TableCell>
                  <TableCell><PriorityChip priority={r.thread.priority} /></TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.repliedAt, tz, now)}</TableCell>
                  <TableCell className="max-w-40 truncate text-xs">{r.repliedByAddress ?? "–"}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {r.repliedAt ? (
                      <Tooltip><TooltipTrigger asChild><span tabIndex={0}>{formatMinutes(r.responseBusinessMinutes)}</span></TooltipTrigger><TooltipContent>Wall-clock: {formatMinutes(r.responseMinutes)}</TooltipContent></Tooltip>
                    ) : "–"}
                    {r.replyMethod && <span className="block text-[11px] text-muted-foreground">{METHOD[r.replyMethod] ?? r.replyMethod}</span>}
                  </TableCell>
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
