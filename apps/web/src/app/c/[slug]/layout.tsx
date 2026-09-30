import type { CSSProperties } from "react";
import { signOut } from "@/auth";
import { Sidebar, MobileNav } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { fontClasses } from "@/lib/fonts";
import { getCompanyContext, getVisibleCompanies } from "@/lib/session";
import { cn } from "@/lib/utils";

export default async function CompanyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { session, org, role, mailboxes } = await getCompanyContext(slug);
  const companies = await getVisibleCompanies(session);
  const brand = { "--brand": org.primaryColor, "--brand-secondary": org.secondaryColor } as CSSProperties;
  async function doSignOut() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }
  return (
    <div style={brand} className={cn("flex min-h-screen bg-background font-sans", fontClasses(org.headingFont, org.bodyFont))}>
      <Sidebar current={{ slug: org.slug, name: org.name, logoUrl: org.logoUrl, isDemo: org.isDemo }} companies={companies.map((c) => ({ slug: c.slug, name: c.name, logoUrl: c.logoUrl }))} role={role} isOwner={session.isOwner} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar mailboxes={mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress, isActive: m.isActive }))} user={{ email: session.email, name: session.name, role }} timezone={org.timezone} signOut={doSignOut} />
        <MobileNav role={role} isOwner={session.isOwner} />
        {org.isDemo && <div className="border-b border-brand-secondary/40 bg-brand-secondary/10 px-4 py-1.5 text-center text-xs text-foreground">Demo data — this organization was created by <code>pnpm db:seed-demo</code> and can be removed with <code>--remove</code>.</div>}
        {!org.azureTenantId && !org.isDemo && <div className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-center text-xs text-foreground">This company is not connected to Microsoft 365 yet — an owner must run "Connect Microsoft 365" on the Companies page before mail can be synced.</div>}
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
