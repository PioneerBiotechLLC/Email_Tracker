"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { BarChart3, Inbox, Layers, MessagesSquare, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: BarChart3 },
  { href: "/tracker", label: "Inbox Tracker", icon: Inbox },
  { href: "/threads", label: "Threads", icon: MessagesSquare },
  { href: "/subjects", label: "By Subject", icon: Layers },
  { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
];

function useNavHref() {
  const sp = useSearchParams();
  // Keep the mailbox and date range when moving between pages; drop page-specific filters.
  const keep = new URLSearchParams();
  for (const k of ["mailbox", "range", "from", "to"]) {
    const v = sp.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  return (href: string) => (qs ? `${href}?${qs}` : href);
}

export function Sidebar({ orgName, logoUrl, isDemo, role }: { orgName: string; logoUrl: string | null; isDemo: boolean; role: "admin" | "viewer" }) {
  const pathname = usePathname();
  const nav = useNavHref();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex" aria-label="Main navigation">
      <div className="flex items-center gap-3 border-b px-5 py-4">
        {logoUrl ? <img src={logoUrl} alt="" className="h-8 w-8 rounded object-contain" /> : <div className="flex h-8 w-8 items-center justify-center rounded bg-primary font-heading text-sm font-bold text-primary-foreground">{orgName.slice(0, 1)}</div>}
        <div className="min-w-0">
          <div className="truncate font-heading text-sm font-bold leading-tight">{orgName}</div>
          <div className="text-xs text-muted-foreground">{isDemo ? "Demo" : "Email Tracker"}</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV.filter((n) => !n.adminOnly || role === "admin").map((n) => {
          const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
          return (
            <Link key={n.href} href={nav(n.href)} aria-current={active ? "page" : undefined}
              className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors", active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
              <n.icon className="size-4" aria-hidden />
              {n.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

export function MobileNav({ role }: { role: "admin" | "viewer" }) {
  const pathname = usePathname();
  const nav = useNavHref();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-1 md:hidden" aria-label="Main navigation">
      {NAV.filter((n) => !n.adminOnly || role === "admin").map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link key={n.href} href={nav(n.href)} aria-current={active ? "page" : undefined} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium", active ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
