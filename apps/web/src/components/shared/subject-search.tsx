"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { withParams } from "@/lib/url-params";

export function SubjectSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  return (
    <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); router.push(pathname + withParams(sp, { q: q || null, page: null })); }}>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search subjects…" aria-label="Search subjects" className="h-9 w-full rounded-md border bg-background px-2 text-sm sm:w-72" />
    </form>
  );
}
