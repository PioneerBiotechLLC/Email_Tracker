import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/badges";
import { Pagination } from "@/components/shared/pagination";
import { SubjectSearch } from "@/components/shared/subject-search";
import { getSubjectGroups } from "@/lib/data/subjects";
import { parseFilters, type SearchParams } from "@/lib/filters";
import { formatDateTime } from "@/lib/format";
import { getOrgContext } from "@/lib/org";
import { getSessionContext } from "@/lib/session";

export const metadata = { title: "By Subject" };

export default async function SubjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getSessionContext();
  const { org } = await getOrgContext(ctx.orgId);
  const f = parseFilters(sp, org.timezone);
  const now = new Date();
  const { groups, total, pages } = await getSubjectGroups(ctx, f, now);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">By Subject</h1>
      <p className="text-sm text-muted-foreground">Threads grouped by their cleaned subject (RE/FW prefixes and ticket tags removed), so the same topic split over several conversations shows together.</p>
      <SubjectSearch />
      {groups.length === 0 ? <EmptyState title="No subjects in this range" /> : (
        <div className="divide-y rounded-lg border">
          {groups.map((g) => (
            <details key={g.normalizedSubject} className="group">
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 p-3 hover:bg-accent/50">
                <span className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>▶</span>
                {g.worst && <StatusBadge status={g.worst} />}
                <span className="min-w-0 flex-1 truncate font-medium" dir="auto">{g.normalizedSubject}</span>
                <span className="text-xs text-muted-foreground">{g.threadCount} thread{g.threadCount === 1 ? "" : "s"} · {g.messageCount} messages · latest {formatDateTime(g.lastMessageAt, org.timezone, now)}</span>
              </summary>
              <ul className="divide-y border-t bg-muted/30">
                {g.threads.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2 ps-10 text-sm">
                    <StatusBadge status={t.status} overdueAt={t.overdueAt} now={now} />
                    <Link href={`/threads/${t.id}`} className="min-w-0 flex-1 truncate hover:underline" dir="auto">{t.subject}</Link>
                    <span className="text-xs text-muted-foreground">{t.messageCount} msgs · {formatDateTime(t.lastMessageAt, org.timezone, now)} · {t.mailbox.emailAddress}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      <Pagination page={f.page} pages={pages} total={total} sp={sp} label="subjects" />
    </div>
  );
}
