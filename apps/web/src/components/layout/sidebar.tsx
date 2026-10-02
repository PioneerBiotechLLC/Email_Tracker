"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { BarChart3, Building2, ChevronsUpDown, Inbox, Layers, MessageCircleQuestion, MessagesSquare, Settings, Sparkles } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { rememberCompany } from "@/app/c/company-cookie";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "", label: "Overview", icon: BarChart3 },
  { href: "/tracker", label: "Inbox Tracker", icon: Inbox },
  { href: "/threads", label: "Threads", icon: MessagesSquare },
  { href: "/subjects", label: "By Subject", icon: Layers },
  { href: "/summary", label: "Summary", icon: Sparkles },
  { href: "/ask", label: "Ask", icon: MessageCircleQuestion, chatOnly: true },
  { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
];

export interface CompanyItem { slug: string; name: string; logoUrl: string | null }

function useNav() {
  const params = useParams<{ slug: string }>();
  const sp = useSearchParams();
  const pathname = usePathname();
  const base = `/c/${params.slug}`;
  const keep = new URLSearchParams();
  for (const k of ["mailbox", "range", "from", "to"]) {
    const v = sp.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString();
  const href = (h: string) => `${base}${h}${qs ? `?${qs}` : ""}`;
  const active = (h: string) => (h === "" ? pathname === base : pathname.startsWith(`${base}${h}`));
  return { href, active, base };
}

function Logo({ name, logoUrl, size = "h-8 w-8" }: { name: string; logoUrl: string | null; size?: string }) {
  return logoUrl ? <img src={logoUrl} alt="" className={cn(size, "rounded object-contain")} /> : <div className={cn(size, "flex items-center justify-center rounded bg-primary font-heading text-sm font-bold text-primary-foreground")}>{name.slice(0, 1)}</div>;
}

export function CompanySwitcher({ current, companies, isOwner }: { current: CompanyItem & { isDemo: boolean }; companies: CompanyItem[]; isOwner: boolean }) {
  const router = useRouter();
  useEffect(() => { void rememberCompany(current.slug); }, [current.slug]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-3 border-b px-5 py-4 text-left hover:bg-accent/50" aria-label="Switch company">
        <Logo name={current.name} logoUrl={current.logoUrl} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-heading text-sm font-bold leading-tight">{current.name}</div>
          <div className="text-xs text-muted-foreground">{current.isDemo ? "Demo" : companies.length > 1 ? `${companies.length} companies` : "Email Tracker"}</div>
        </div>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Companies</DropdownMenuLabel>
        {companies.map((c) => (
          <DropdownMenuItem key={c.slug} onSelect={() => router.push(`/c/${c.slug}`)} className={cn(c.slug === current.slug && "font-semibold")}>
            <Logo name={c.name} logoUrl={c.logoUrl} size="h-5 w-5" /> {c.name}
          </DropdownMenuItem>
        ))}
        {isOwner && (<><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => router.push("/companies")}><Building2 className="size-4" /> Manage companies</DropdownMenuItem></>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Menu entries this user sees: Settings for admins only, Ask only while the chat is switched on. */
const visibleNav = (role: "admin" | "viewer", chatEnabled: boolean) => NAV.filter((n) => (!n.adminOnly || role === "admin") && (!n.chatOnly || chatEnabled));

export function Sidebar({ current, companies, role, isOwner, chatEnabled }: { current: CompanyItem & { isDemo: boolean }; companies: CompanyItem[]; role: "admin" | "viewer"; isOwner: boolean; chatEnabled: boolean }) {
  const { href, active } = useNav();
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex" aria-label="Main navigation">
      <CompanySwitcher current={current} companies={companies} isOwner={isOwner} />
      <nav className="flex flex-1 flex-col gap-1 p-3">
        {visibleNav(role, chatEnabled).map((n) => (
          <Link key={n.href} href={href(n.href)} aria-current={active(n.href) ? "page" : undefined}
            className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors", active(n.href) ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
            <n.icon className="size-4" aria-hidden />
            {n.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}

export function MobileNav({ role, isOwner, chatEnabled }: { role: "admin" | "viewer"; isOwner: boolean; chatEnabled: boolean }) {
  const { href, active } = useNav();
  return (
    <nav className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-1 md:hidden" aria-label="Main navigation">
      {visibleNav(role, chatEnabled).map((n) => (
        <Link key={n.href} href={href(n.href)} aria-current={active(n.href) ? "page" : undefined} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium", active(n.href) ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
          {n.label}
        </Link>
      ))}
      {isOwner && <Link href="/companies" className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground">Companies</Link>}
    </nav>
  );
}
