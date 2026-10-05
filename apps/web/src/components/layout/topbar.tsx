"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOut, Moon, Sun, UserCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { withParams } from "@/lib/url-params";

interface Mailbox { id: string; emailAddress: string; isActive: boolean }

/** Pages whose content the mailbox and date-range controls change (not Settings, Ask or a single thread). */
const FILTERED_PAGE = /^\/c\/[^/]+(\/(tracker|threads|subjects|summary))?\/?$/;

export function Topbar({ mailboxes, user, timezone, signOut }: { mailboxes: Mailbox[]; user: { email: string; name: string | null; role: string }; timezone: string; signOut: () => Promise<void> }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const { resolvedTheme, setTheme } = useTheme();
  const range = sp.get("range") ?? "30d";
  const go = (overrides: Record<string, string | null>) => router.push(pathname + withParams(sp, { ...overrides, page: null }));
  const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";
  const filters = FILTERED_PAGE.test(pathname);

  return (
    <header className="flex min-h-[3.25rem] flex-wrap items-center gap-2 border-b bg-card px-4 py-2 md:px-8">
      {filters && (<>
      <label className="flex items-center gap-2 text-sm">
        <span className="sr-only">Mailbox</span>
        <select className={selectClass} value={sp.get("mailbox") ?? "all"} onChange={(e) => go({ mailbox: e.target.value === "all" ? null : e.target.value })} aria-label="Mailbox">
          <option value="all">All mailboxes</option>
          {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress}{m.isActive ? "" : " (paused)"}</option>)}
        </select>
      </label>
      <div className="flex items-center rounded-md border bg-background p-0.5" role="group" aria-label="Date range">
        {(["7d", "30d", "90d", "custom"] as const).map((r) => (
          <button key={r} type="button" onClick={() => go({ range: r })} aria-pressed={range === r}
            className={`press rounded px-2.5 py-1 text-sm ${range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {r === "custom" ? "Custom" : r.replace("d", " days")}
          </button>
        ))}
      </div>
      {range === "custom" && (
        <div className="flex items-center gap-1 text-sm">
          <input type="date" aria-label="From" className={selectClass} defaultValue={sp.get("from") ?? ""} onChange={(e) => go({ range: "custom", from: e.target.value })} />
          <span className="text-muted-foreground">–</span>
          <input type="date" aria-label="To" className={selectClass} defaultValue={sp.get("to") ?? ""} onChange={(e) => go({ range: "custom", to: e.target.value })} />
        </div>
      )}
      </>)}
      <span className="hidden text-xs text-muted-foreground lg:inline">Times in {timezone}</span>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Toggle dark mode" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          <Sun className="size-4 dark:hidden" /><Moon className="hidden size-4 dark:block" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="gap-2" aria-label="User menu"><UserCircle2 className="size-5" /><span className="hidden max-w-40 truncate sm:inline">{user.name ?? user.email}</span></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="font-normal"><div className="truncate text-sm">{user.email}</div><div className="text-xs text-muted-foreground">{user.role}</div></DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void signOut()}><LogOut className="size-4" /> Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
