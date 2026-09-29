import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { CategoryChip, PriorityChip, StatusBadge } from "@/components/shared/badges";
import { FilterBar } from "@/components/shared/filter-bar";
import { Pagination } from "@/components/shared/pagination";
import { getThreadsPage } from "@/lib/data/threads";
import { parseFilters, type SearchParams } from "@/lib/filters";
import { formatDateTime } from "@/lib/format";
import { getOrgContext } from "@/lib/org";
import { getSessionContext } from "@/lib/session";

export const metadata = { title: "Threads" };
const STATUSES = [
  { value: "overdue", label: "Overdue" }, { value: "awaiting_us", label: "Awaiting our reply" }, { value: "awaiting_them", label: "Waiting on them" },
  { value: "no_reply_needed", label: "No reply needed" }, { value: "closed", label: "Closed" }, { value: "summary_pending", label: "Summary pending" }, { value: "summary_error", label: "Summary error" },
];

function participants(json: unknown, mailbox: string): string {
  const list = Array.isArray(json) ? (json as { address: string; name?: string | null }[]) : [];
  return list.filter((p) => p.address !== mailbox).map((p) => p.name || p.address).slice(0, 3).join(", ");
}

export default async function ThreadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getSessionContext();
  const { org } = await getOrgContext(ctx.orgId);
  const f = parseFilters(sp, org.timezone);
  const now = new Date();
  const { rows, total, pages } = await getThreadsPage(ctx, f, now);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Threads</h1>
      <FilterBar statuses={STATUSES} />
      {rows.length === 0 ? <EmptyState title="No threads in this range" hint="Threads are listed by their last activity. Try a wider date range." /> : (
        <ul className="divide-y rounded-lg border" data-testid="thread-list">
          {rows.map((t) => (
            <li key={t.id} className="flex flex-col gap-1.5 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={t.status} overdueAt={t.overdueAt} now={now} />
                <Link href={`/threads/${t.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline" dir="auto">{t.subject || "(no subject)"}</Link>
                <CategoryChip category={t.category} /><PriorityChip priority={t.priority} />
              </div>
              <div className="text-xs text-muted-foreground" dir="auto">{participants(t.participants, t.mailbox.emailAddress) || t.mailbox.emailAddress} · {t.messageCount} message{t.messageCount === 1 ? "" : "s"} · last activity {formatDateTime(t.lastMessageAt, org.timezone, now)} · {t.mailbox.emailAddress}</div>
              {t.summary ? (
                <p className="line-clamp-2 text-sm" dir="auto">{t.summary}{t.messageCount > t.summaryMessageCount && <span className="ml-1 text-xs text-muted-foreground">(new messages since summary)</span>}</p>
              ) : t.summaryError ? (
                <p className="text-sm text-status-bad">Summary error — will be retried. <span className="text-muted-foreground">{t.summaryError.replace(/^\S+\s/, "").slice(0, 80)}</span></p>
              ) : (
                <p className="text-sm italic text-muted-foreground">Summary pending</p>
              )}
              {t.nextAction && <p className="text-sm" dir="auto"><span className="font-medium">Next:</span> {t.nextAction}</p>}
            </li>
          ))}
        </ul>
      )}
      <Pagination page={f.page} pages={pages} total={total} sp={sp} label="threads" />
    </div>
  );
}
