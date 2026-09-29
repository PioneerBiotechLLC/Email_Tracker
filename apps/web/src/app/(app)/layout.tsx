import type { CSSProperties } from "react";
import { signOut } from "@/auth";
import { Sidebar, MobileNav } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { getOrgContext } from "@/lib/org";
import { getSessionContext } from "@/lib/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getSessionContext();
  const { org, mailboxes } = await getOrgContext(ctx.orgId);
  const brand = { "--brand": org.primaryColor } as CSSProperties;
  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }
  return (
    <div style={brand} className="flex min-h-screen bg-background">
      <Sidebar orgName={org.name} logoUrl={org.logoUrl} isDemo={org.isDemo} role={ctx.role} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar mailboxes={mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress, isActive: m.isActive }))} user={{ email: ctx.email, name: ctx.name, role: ctx.role }} timezone={org.timezone} signOut={doSignOut} />
        <MobileNav role={ctx.role} />
        {org.isDemo && <div className="border-b border-brand-secondary/40 bg-brand-secondary/10 px-4 py-1.5 text-center text-xs text-foreground">Demo data — this organization was created by <code>pnpm db:seed-demo</code> and can be removed with <code>--remove</code>.</div>}
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
