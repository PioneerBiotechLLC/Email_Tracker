import { cn } from "@/lib/utils";
import { CATEGORY_LABEL, STATUS_LABEL, titleCase } from "@/lib/format";

const STATUS_CLASS: Record<string, string> = {
  replied: "status-replied", awaiting_them: "status-replied", waiting: "status-waiting", awaiting_us: "status-waiting", overdue: "status-overdue",
  no_reply_needed: "status-muted", closed: "status-muted",
};

/** Status by text and color (never color alone). Pass `overdueAt` to render awaiting_us threads as Overdue. */
export function StatusBadge({ status, overdueAt, now = new Date(), className }: { status: string; overdueAt?: Date | null; now?: Date; className?: string }) {
  const s = status === "awaiting_us" && overdueAt && overdueAt.getTime() <= now.getTime() ? "overdue" : status;
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", STATUS_CLASS[s] ?? "status-muted", className)}>{STATUS_LABEL[s] ?? titleCase(s)}</span>;
}

export function CategoryChip({ category }: { category: string }) {
  return <span className="inline-flex whitespace-nowrap rounded border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{CATEGORY_LABEL[category] ?? titleCase(category)}</span>;
}

export function PriorityChip({ priority }: { priority: string }) {
  const cls = priority === "urgent" ? "text-status-bad border-status-bad/40" : priority === "high" ? "text-status-warn border-status-warn/50" : "text-muted-foreground";
  return <span className={cn("inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium", cls)}>{titleCase(priority)}</span>;
}
