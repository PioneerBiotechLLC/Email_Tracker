import Link from "next/link";
import { adminConsentUrl, databaseStorage, formatBytes, getDb, getEnv, signConsentState } from "@email-tracker/core";
import { addCompany, addMailbox, updateCompany } from "@/actions/companies";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SettingsForm, field } from "@/components/settings/forms";
import { BODY_FONTS, HEADING_FONTS } from "@/lib/fonts";
import { formatDateTime, formatSince } from "@/lib/format";
import { requireOwner, isProduction } from "@/lib/session";

export const metadata = { title: "Companies" };
export const dynamic = "force-dynamic";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function CompanyFields({ org }: { org?: { name: string; slug: string; domain: string; domains: string[]; azureTenantId: string | null; timezone: string; workDays: number[]; workStart: string; workEnd: string; replySlaHours: number | null; summaryLanguage: string; logoUrl: string | null; primaryColor: string; secondaryColor: string; headingFont: string; bodyFont: string; aiContext: string | null } }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">Name<input name="name" required defaultValue={org?.name} className={field} /></label>
      <label className="block">Slug (URL: /c/…)<input name="slug" defaultValue={org?.slug} placeholder="auto from name" className={field} /></label>
      <label className="block">Primary email domain<input name="domain" required defaultValue={org?.domain} placeholder="pbio.tech" className={field} /></label>
      <label className="block">Other domains (comma separated)<input name="domains" defaultValue={org?.domains.join(", ")} className={field} /></label>
      <label className="block">Microsoft 365 tenant ID<input name="azureTenantId" defaultValue={org?.azureTenantId ?? ""} placeholder="filled by Connect Microsoft 365" className={field} /></label>
      <label className="block">Timezone<input name="timezone" defaultValue={org?.timezone ?? "Asia/Dubai"} className={field} /></label>
      <fieldset className="sm:col-span-2"><legend className="mb-1">Work days</legend><div className="flex flex-wrap gap-3">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1"><input type="checkbox" name="workDays" value={i} defaultChecked={(org?.workDays ?? [0, 1, 2, 3, 4]).includes(i)} /> {d}</label>)}</div></fieldset>
      <label className="block">Work start<input type="time" name="workStart" defaultValue={org?.workStart ?? "09:00"} className={field} /></label>
      <label className="block">Work end<input type="time" name="workEnd" defaultValue={org?.workEnd ?? "18:00"} className={field} /></label>
      <label className="block">Reply SLA (business hours)<input type="number" step="0.5" name="replySlaHours" defaultValue={org?.replySlaHours ?? 24} className={field} /></label>
      <label className="block">Summary language<select name="summaryLanguage" defaultValue={org?.summaryLanguage ?? "en"} className={field}><option value="en">English</option><option value="ar">Arabic</option></select></label>
      <label className="block">Logo URL<input name="logoUrl" type="url" defaultValue={org?.logoUrl ?? ""} className={field} /></label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">Primary color<input type="color" name="primaryColor" defaultValue={org?.primaryColor ?? "#BE272C"} className="mt-1 h-9 w-full rounded border bg-background" /></label>
        <label className="block">Secondary color<input type="color" name="secondaryColor" defaultValue={org?.secondaryColor ?? "#BE6B27"} className="mt-1 h-9 w-full rounded border bg-background" /></label>
      </div>
      <label className="block">Heading font<select name="headingFont" defaultValue={org?.headingFont ?? "merriweather"} className={field}>{HEADING_FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="block">Body font<select name="bodyFont" defaultValue={org?.bodyFont ?? "source-sans"} className={field}>{BODY_FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <label className="block sm:col-span-2">AI context (what this company does; used in every summary prompt)<textarea name="aiContext" rows={3} defaultValue={org?.aiContext ?? ""} className="mt-1 w-full rounded-md border bg-background p-2" /></label>
    </div>
  );
}

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ consent?: string; company?: string; detail?: string }> }) {
  const owner = await requireOwner();
  const sp = await searchParams;
  const db = getDb();
  const env = getEnv();
  const now = new Date();
  const [orgs, storage] = await Promise.all([
    db.organization.findMany({ where: isProduction ? { isDemo: false } : {}, orderBy: { name: "asc" }, include: { mailboxes: { orderBy: { emailAddress: "asc" } }, _count: { select: { memberships: true, mailboxes: true } } } }),
    databaseStorage(db, env.DB_STORAGE_LIMIT_MB).catch(() => null),
  ]);
  const appUrl = env.APP_URL?.replace(/\/$/, "");
  const consentReady = !!(appUrl && env.AZURE_CLIENT_ID && process.env.AUTH_SECRET);

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h1 className="text-2xl font-bold">Companies</h1><p className="text-sm text-muted-foreground">Owner view · signed in as {owner.email} · <Link href="/" className="underline">back to dashboard</Link></p></div>
        {storage && (
          <div className={`rounded-md border px-3 py-2 text-sm ${storage.warn ? "status-overdue" : ""}`} role="status">
            Database: <strong>{formatBytes(storage.bytes)}</strong> of {formatBytes(storage.limitBytes)} ({storage.pct}%){storage.warn && " — near the plan limit: switch companies to preview-only storage or shorten retention"}
          </div>
        )}
      </div>
      {sp.consent && (
        <div className={`rounded-md border px-3 py-2 text-sm ${sp.consent === "ok" ? "status-replied" : "status-overdue"}`} role="status">
          {sp.consent === "ok" ? `Microsoft 365 connected for ${sp.company}. Now run the Application Access Policy PowerShell in that tenant (see docs/DEPLOY.md), then add mailboxes.` : `Connect Microsoft 365 failed: ${sp.detail ?? sp.consent}`}
        </div>
      )}
      {!consentReady && <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">"Connect Microsoft 365" needs APP_URL, AZURE_CLIENT_ID and AUTH_SECRET set (production).</p>}

      {orgs.map((org) => {
        const consentUrl = consentReady ? adminConsentUrl({ clientId: env.AZURE_CLIENT_ID!, redirectUri: `${appUrl}/api/graph/consent/callback`, state: signConsentState(org.id, process.env.AUTH_SECRET!), tenantId: org.azureTenantId }) : null;
        const lastSync = org.mailboxes.map((m) => m.lastSyncedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
        return (
          <Card key={org.id}>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2"><span className="inline-block h-4 w-4 rounded" style={{ background: org.primaryColor }} aria-hidden />{org.name}{org.isDemo && <span className="text-xs font-normal text-muted-foreground">(demo)</span>}</CardTitle>
                <CardDescription>
                  <Link href={`/c/${org.slug}`} className="underline">/c/{org.slug}</Link> · {org.domain}{org.domains.length ? `, ${org.domains.join(", ")}` : ""} · {org._count.memberships} members · {org._count.mailboxes} mailboxes
                </CardDescription>
              </div>
              <div className="text-right text-sm">
                <div>{org.azureTenantId ? <span className="text-status-ok">Microsoft 365 connected</span> : <span className="text-status-warn">Not connected</span>}{org.consentGrantedAt && <span className="text-muted-foreground"> · consent {formatDateTime(org.consentGrantedAt, org.timezone, now)}</span>}</div>
                <div className="text-muted-foreground">{org.azureTenantId ? `tenant ${org.azureTenantId}` : "tenant unknown"} · last sync {lastSync ? formatSince(new Date(lastSync), now) + " ago" : "never"}</div>
                {consentUrl && !org.isDemo && <Button asChild size="sm" className="mt-2"><a href={consentUrl}>{org.azureTenantId ? "Re-run Connect Microsoft 365" : "Connect Microsoft 365"}</a></Button>}
              </div>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold">Mailboxes</h3>
                <ul className="divide-y text-sm">
                  {org.mailboxes.map((m) => (
                    <li key={m.id} className="py-1.5">
                      <div>{m.emailAddress}{!m.isActive && <span className="text-muted-foreground"> (paused)</span>}</div>
                      <div className="text-xs text-muted-foreground">synced {formatDateTime(m.lastSyncedAt, org.timezone, now)} · notifications {m.subscriptionExpiresAt ? `until ${formatDateTime(m.subscriptionExpiresAt, org.timezone, now)}` : "none"}{m.lastSyncError && <span className="text-status-bad"> · error: {m.lastSyncError.slice(0, 80)}</span>}</div>
                    </li>
                  ))}
                  {!org.mailboxes.length && <li className="py-1.5 text-muted-foreground">No mailboxes yet.</li>}
                </ul>
                {!org.isDemo && (
                  <div className="mt-3">
                    <SettingsForm action={addMailbox.bind(null, org.id)} submitLabel="Add mailbox">
                      <label className="block text-sm">Mailbox address<input name="email" type="email" required placeholder={`sales@${org.domain}`} className={field} /></label>
                    </SettingsForm>
                    <p className="mt-1 text-xs text-muted-foreground">Requires admin consent and the Application Access Policy in this company's tenant. The initial 90-day backfill runs from your laptop: <code>pnpm sync:once &lt;mailbox&gt;</code>.</p>
                  </div>
                )}
              </div>
              <details>
                <summary className="cursor-pointer text-sm font-semibold">Edit company settings</summary>
                <div className="mt-3">
                  <SettingsForm action={updateCompany.bind(null, org.id)}><CompanyFields org={org} /></SettingsForm>
                </div>
              </details>
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader><CardTitle>Add a company</CardTitle><CardDescription>Creates the company record. Then: Connect Microsoft 365 (tenant admin consent) → Application Access Policy in that tenant → add mailboxes → backfill from your laptop.</CardDescription></CardHeader>
        <CardContent><SettingsForm action={addCompany} submitLabel="Create company"><CompanyFields /></SettingsForm></CardContent>
      </Card>
    </main>
  );
}
