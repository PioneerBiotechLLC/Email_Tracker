import Link from "next/link";
import { withParams, type SearchParams } from "@/lib/filters";
import { Button } from "@/components/ui/button";

export function Pagination({ page, pages, total, sp, label = "rows" }: { page: number; pages: number; total: number; sp: SearchParams; label?: string }) {
  return (
    <nav className="flex items-center justify-between gap-2 py-3 text-sm text-muted-foreground" aria-label="Pagination">
      <span>{total.toLocaleString("en-US")} {label} · page {page} of {pages}</span>
      <div className="flex gap-1">
        <Button asChild variant="outline" size="sm" disabled={page <= 1} aria-disabled={page <= 1}><Link href={withParams(sp, { page: String(Math.max(1, page - 1)) })} aria-label="Previous page">Previous</Link></Button>
        <Button asChild variant="outline" size="sm" disabled={page >= pages} aria-disabled={page >= pages}><Link href={withParams(sp, { page: String(Math.min(pages, page + 1)) })} aria-label="Next page">Next</Link></Button>
      </div>
    </nav>
  );
}

export function SortLink({ col, label, sp, current, dir }: { col: string; label: string; sp: SearchParams; current: string; dir: "asc" | "desc" }) {
  const active = current === col;
  const next = active && dir === "desc" ? "asc" : "desc";
  return (
    <Link href={withParams(sp, { sort: col, dir: next, page: null })} className="inline-flex items-center gap-1 hover:text-foreground" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
      {label}{active && <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>}
    </Link>
  );
}
