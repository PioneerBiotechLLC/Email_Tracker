import { toggleMailbox, updateBranding, updateBusinessHours, updateDigest, updateStorage } from "@/actions/settings";
import { BODY_FONTS, HEADING_FONTS } from "@/lib/fonts";
import { addUser, removeUser, setUserRole } from "@/actions/users";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmForm } from "@/components/shared/confirm-form";
import { SettingsForm, field } from "@/components/settings/forms";
import { getSettings } from "@/lib/data/settings";
import { formatDateTime, formatUsd } from "@/lib/format";
import { requireAdminPage } from "@/lib/session";

export const metadata = { title: "Settings" };
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { ctx } = await requireAdminPage(slug);
  const s = await getSettings(ctx);
  const orgId = ctx.orgId;
  const tz = s.org.timezone;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Mailboxes</CardTitle><CardDescription>Owners add mailboxes on the <a href="/companies" className="underline">Companies</a> page (or <code className="rounded bg-muted px-1">pnpm mailbox add user@{s.org.domain}</code>). The first sync loads recent history; run <code className="rounded bg-muted px-1">pnpm sync:once</code> from a laptop for a longer backfill.</CardDescription></CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {s.mailboxes.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{m.emailAddress} {!m.isActive && <span className="text-xs text-muted-foreground">(paused)</span>}</div>
                    <div className="text-xs text-muted-foreground">{m._count.threads} threads · {m._count.messages} messages · last synced {formatDateTime(m.lastSyncedAt, tz, now)}</div>
                    {m.lastSyncError && <div className="text-xs text-status-bad">Sync error {formatDateTime(m.lastSyncErrorAt, tz, now)}: {m.lastSyncError.slice(0, 160)}</div>}
                  </div>
                  <ConfirmForm action={toggleMailbox.bind(null, orgId, m.id, !m.isActive)} confirmText={m.isActive ? "Pause syncing this mailbox?" : "Resume syncing this mailbox?"}>{m.isActive ? "Pause" : "Resume"}</ConfirmForm>
                </li>
              ))}
              {!s.mailboxes.length && <li className="py-2 text-muted-foreground">No mailboxes yet.</li>}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Business hours &amp; reply SLA</CardTitle><CardDescription>Response times and the overdue flag are computed inside these hours. Saving recomputes every thread.</CardDescription></CardHeader>
          <CardContent>
            <SettingsForm action={updateBusinessHours.bind(null, orgId)}>
              <label className="block">Timezone<input name="timezone" defaultValue={s.org.timezone} className={field} required /></label>
              <fieldset><legend className="mb-1">Work days</legend><div className="flex flex-wrap gap-3">{DAYS.map((d, i) => <label key={d} className="flex items-center gap-1"><input type="checkbox" name="workDays" value={i} defaultChecked={s.org.workDays.includes(i)} /> {d}</label>)}</div></fieldset>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">Start<input type="time" name="workStart" defaultValue={s.org.workStart} className={field} required /></label>
                <label className="block">End<input type="time" name="workEnd" defaultValue={s.org.workEnd} className={field} required /></label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">Reply SLA (business hours)<input type="number" step="0.5" min="0.5" name="replySlaHours" defaultValue={s.org.replySlaHours ?? ""} placeholder="24 (from REPLY_SLA_HOURS)" className={field} /></label>
                <label className="block">Summary language<select name="summaryLanguage" defaultValue={s.org.summaryLanguage} className={field}><option value="en">English</option><option value="ar">Arabic</option></select></label>
              </div>
            </SettingsForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Branding</CardTitle><CardDescription>Primary color is used for the active navigation, buttons and highlights. Status colors stay independent.</CardDescription></CardHeader>
          <CardContent>
            <SettingsForm action={updateBranding.bind(null, orgId)}>
              <label className="block">Logo URL<input name="logoUrl" type="url" defaultValue={s.org.logoUrl ?? ""} placeholder="https://…/logo.png" className={field} /></label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">Primary color<div className="mt-1 flex items-center gap-2"><input type="color" name="primaryColor" defaultValue={s.org.primaryColor} className="h-9 w-14 rounded border bg-background" aria-label="Primary color" /><span className="text-muted-foreground">{s.org.primaryColor}</span></div></label>
                <label className="block">Secondary color<div className="mt-1 flex items-center gap-2"><input type="color" name="secondaryColor" defaultValue={s.org.secondaryColor} className="h-9 w-14 rounded border bg-background" aria-label="Secondary color" /><span className="text-muted-foreground">{s.org.secondaryColor}</span></div></label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">Heading font<select name="headingFont" defaultValue={s.org.headingFont} className={field}>{HEADING_FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                <label className="block">Body font<select name="bodyFont" defaultValue={s.org.bodyFont} className={field}>{BODY_FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              </div>
            </SettingsForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Daily digest</CardTitle><CardDescription>Stored now; sending arrives in Phase 6. Time is in {tz}.</CardDescription></CardHeader>
          <CardContent>
            <SettingsForm action={updateDigest.bind(null, orgId)}>
              <label className="block">Recipients (comma or newline separated)<textarea name="digestRecipients" rows={3} defaultValue={s.org.digestRecipients.join("\n")} className="mt-1 w-full rounded-md border bg-background p-2" /></label>
              <label className="block">Send time<input type="time" name="digestTime" defaultValue={`${pad(s.org.digestHour)}:${pad(s.org.digestMinute)}`} className={field} /></label>
            </SettingsForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Storage &amp; retention</CardTitle><CardDescription>Keeps the database small on the free tier. Retention deletes old rows from our database only — never from the mailbox.</CardDescription></CardHeader>
          <CardContent>
            <SettingsForm action={updateStorage.bind(null, orgId)}>
              <label className="block">Store email bodies<select name="bodyStorage" defaultValue={s.org.bodyStorage} className={field}><option value="full">Full cleaned text (best summaries)</option><option value="preview_only">Preview only (first ~500 characters)</option></select></label>
              <label className="block">Keep emails for (days)<input type="number" name="retentionDays" min={30} max={3650} defaultValue={s.org.retentionDays} className={field} /></label>
            </SettingsForm>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>AI usage this month</CardTitle><CardDescription>Model {s.ai.model}{s.ai.light ? ` (light: ${s.ai.light})` : ""} · daily cap {s.ai.cap} calls per organization · API key {s.ai.keyConfigured ? "configured" : "missing"}</CardDescription></CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">By model</h3>
              <UsageTable rows={s.usage.byModel} />
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">By day</h3>
              <UsageTable rows={[...s.usage.byDay].reverse()} />
            </div>
            <p className="text-sm md:col-span-2">Total: <strong>{s.usage.total.calls}</strong> calls ({s.usage.total.errors} errors), {s.usage.total.inputTokens.toLocaleString("en-US")} input / {s.usage.total.outputTokens.toLocaleString("en-US")} output tokens, <strong>{formatUsd(s.usage.total.costUsd)}</strong></p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Users</CardTitle><CardDescription>Members of this company. Admins can change everything; viewers are read-only. A person can belong to several companies; owners see every company.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 font-medium">Email</th><th className="py-1 font-medium">Name</th><th className="py-1 font-medium">Role</th><th className="py-1 font-medium">Last login</th><th className="py-1 font-medium">Status</th><th className="py-1"></th></tr></thead>
              <tbody>
                {s.users.map((m) => (
                  <tr key={m.id} className="border-t">
                    <td className="py-2">{m.user.email}{m.user.id === ctx.userId && <span className="ms-1 text-xs text-muted-foreground">(you)</span>}{m.user.isOwner && <span className="ms-1 text-xs text-muted-foreground">(owner)</span>}</td>
                    <td className="py-2">{m.user.name ?? "–"}</td>
                    <td className="py-2">
                      <div className="flex gap-1">
                        {m.role === "admin"
                          ? <ConfirmForm action={setUserRole.bind(null, orgId, m.user.id, "viewer")} confirmText={`Make ${m.user.email} a viewer (read-only) in this company?`} disabled={m.user.id === ctx.userId}>Admin → viewer</ConfirmForm>
                          : <ConfirmForm action={setUserRole.bind(null, orgId, m.user.id, "admin")} confirmText={`Make ${m.user.email} an admin of this company?`}>Viewer → admin</ConfirmForm>}
                      </div>
                    </td>
                    <td className="py-2 text-muted-foreground">{formatDateTime(m.user.lastLoginAt, tz, now)}</td>
                    <td className="py-2">{m.user.isActive ? "Active" : <span className="text-muted-foreground">Deactivated</span>}</td>
                    <td className="py-2 text-right">
                      <ConfirmForm action={removeUser.bind(null, orgId, m.user.id)} confirmText={`Remove ${m.user.email} from this company? Their access to other companies is unchanged.`} variant="ghost" disabled={m.user.id === ctx.userId}>Remove</ConfirmForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <SettingsForm action={addUser.bind(null, orgId)} submitLabel="Add user">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">Email<input name="email" type="email" required className={field} placeholder="name@company.com" /></label>
                <label className="block">Name<input name="name" className={field} /></label>
                <label className="block">Role<select name="role" defaultValue="viewer" className={field}><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label>
              </div>
            </SettingsForm>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function UsageTable({ rows }: { rows: { key: string; calls: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number }[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No calls yet.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1 font-medium">&nbsp;</th><th className="py-1 text-right font-medium">Calls</th><th className="py-1 text-right font-medium">Tokens in / out</th><th className="py-1 text-right font-medium">Cost</th></tr></thead>
      <tbody>{rows.slice(0, 31).map((r) => <tr key={r.key} className="border-t"><td className="py-1">{r.key}</td><td className="py-1 text-right">{r.calls}{r.errors ? <span className="text-status-bad"> ({r.errors} err)</span> : ""}</td><td className="py-1 text-right">{r.inputTokens.toLocaleString("en-US")} / {r.outputTokens.toLocaleString("en-US")}</td><td className="py-1 text-right">{formatUsd(r.costUsd)}</td></tr>)}</tbody>
    </table>
  );
}
