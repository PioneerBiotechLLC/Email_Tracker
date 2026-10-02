"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { withParams } from "@/lib/url-params";
import { CATEGORY_LABEL } from "@/lib/format";

const CATEGORIES = Object.keys(CATEGORY_LABEL);
const PRIORITIES = ["low", "normal", "high", "urgent"];

/** "Show excluded": also lists mail hidden by an "ignore" rule, so it can still be reviewed. */
export function ExcludedToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const on = sp.get("excluded") === "1";
  return (
    <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <input type="checkbox" checked={on} onChange={() => router.push(pathname + withParams(sp, { excluded: on ? null : "1", page: null }))} />
      Show excluded
    </label>
  );
}

export function FilterBar({ statuses, searchPlaceholder = "Search subject, sender, summary…", extra }: { statuses: { value: string; label: string }[]; searchPlaceholder?: string; extra?: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const go = (overrides: Record<string, string | null>) => router.push(pathname + withParams(sp, { ...overrides, page: null }));
  const sel = "h-9 rounded-md border bg-background px-2 text-sm";
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); go({ q: q || null }); }} role="search">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} aria-label="Search" className={`${sel} w-full sm:w-64`} />
      <select aria-label="Status" className={sel} value={sp.get("status") ?? ""} onChange={(e) => go({ status: e.target.value || null })}>
        <option value="">All statuses</option>
        {statuses.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <select aria-label="Category" className={sel} value={sp.get("category") ?? ""} onChange={(e) => go({ category: e.target.value || null })}>
        <option value="">All categories</option>
        {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
      </select>
      <select aria-label="Priority" className={sel} value={sp.get("priority") ?? ""} onChange={(e) => go({ priority: e.target.value || null })}>
        <option value="">All priorities</option>
        {PRIORITIES.map((p) => <option key={p} value={p}>{p[0]!.toUpperCase() + p.slice(1)}</option>)}
      </select>
      {(sp.get("q") || sp.get("status") || sp.get("category") || sp.get("priority")) && (
        <button type="button" className="text-sm text-muted-foreground underline" onClick={() => { setQ(""); go({ q: null, status: null, category: null, priority: null }); }}>Clear</button>
      )}
      {extra}
    </form>
  );
}
