import { NextResponse } from "next/server";
import { toCsv } from "@/lib/csv";
import { EXPORT_LIMIT, getTrackerExport } from "@/lib/data/tracker";
import { parseFilters, type SearchParams } from "@/lib/filters";
import { formatDateTime, STATUS_LABEL } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx, org } = await getCompanyContext(slug);
  const sp: SearchParams = Object.fromEntries(new URL(req.url).searchParams.entries());
  const f = parseFilters(sp, org.timezone);
  const now = new Date();
  const rows = await getTrackerExport(ctx, f, now);
  const tz = org.timezone;
  const csv = toCsv(
    ["Received", "From", "From name", "Subject", "Category", "Priority", "Status", "Replied at", "Replied by", "Response time (business min)", "Response time (raw min)", "Method", "Mailbox", "Thread", "Excluded"],
    rows.map((r) => [formatDateTime(r.receivedAt, tz, now), r.fromAddress, r.fromName, r.subject, r.thread.category, r.thread.priority, STATUS_LABEL[r.status] ?? r.status, r.repliedAt ? formatDateTime(r.repliedAt, tz, now) : "", r.repliedByAddress, r.responseBusinessMinutes, r.responseMinutes, r.replyMethod, r.mailbox.emailAddress, r.threadId, r.exclusionAction ? (r.excludedReason ?? r.exclusionAction) : ""]),
  );
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="inbox-tracker-${f.fromDay}-${f.toDay}.csv"`,
      "X-Row-Limit": String(EXPORT_LIMIT),
    },
  });
}
