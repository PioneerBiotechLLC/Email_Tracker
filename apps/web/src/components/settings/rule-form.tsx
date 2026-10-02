"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/actions/settings";
import { field } from "./forms";

type Save = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
type Preview = (formData: FormData) => Promise<{ count: number } | { error: string }>;

export interface RuleValues {
  type: string;
  value: string;
  andSubjectContains: string | null;
  action: string;
  mailboxId: string | null;
  note: string | null;
}

const TYPES = [
  { value: "sender_domain", label: "Sender domain", placeholder: "godaddy.com" },
  { value: "sender_email", label: "Sender address", placeholder: "billing@godaddy.com or postmaster@*" },
  { value: "subject_contains", label: "Subject contains", placeholder: "account activity" },
  { value: "subject_regex", label: "Subject matches (regex)", placeholder: "^\\[alert\\]" },
];

/** Add / edit form for an exclusion rule, with a live "matches N emails" preview before saving. */
export function RuleForm({ save, preview, mailboxes, rule, submitLabel = "Add rule" }: { save: Save; preview: Preview; mailboxes: { id: string; emailAddress: string }[]; rule?: RuleValues; submitLabel?: string }) {
  const [state, formAction, pending] = useActionState(save, null);
  const [type, setType] = useState(rule?.type ?? "sender_domain");
  const [hint, setHint] = useState<{ ok: boolean; text: string } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const refresh = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!form.current) return;
      const data = new FormData(form.current);
      if (!String(data.get("value") ?? "").trim()) return setHint(null);
      const r = await preview(data);
      setHint("error" in r ? { ok: false, text: r.error } : { ok: true, text: `This rule matches ${r.count.toLocaleString("en-US")} email${r.count === 1 ? "" : "s"} in the last 90 days.` });
    }, 400);
  };

  return (
    <form ref={form} action={formAction} onChange={refresh} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">Match on<select name="type" value={type} onChange={(e) => setType(e.target.value)} className={field}>{TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
        <label className="block">Value<input name="value" required maxLength={200} defaultValue={rule?.value} placeholder={TYPES.find((t) => t.value === type)?.placeholder} className={field} dir="auto" /></label>
        <label className="block">…and subject contains (optional)<input name="andSubjectContains" maxLength={200} defaultValue={rule?.andSubjectContains ?? ""} placeholder="Microsoft 365" className={field} dir="auto" /></label>
        <label className="block">Action<select name="action" defaultValue={rule?.action ?? "ignore"} className={field}><option value="ignore">Ignore (hide everywhere)</option><option value="no_reply_needed">No reply needed (show, don&apos;t count)</option></select></label>
        <label className="block">Mailbox<select name="mailboxId" defaultValue={rule?.mailboxId ?? ""} className={field}><option value="">All mailboxes</option>{mailboxes.map((m) => <option key={m.id} value={m.id}>{m.emailAddress}</option>)}</select></label>
        <label className="block">Note<input name="note" maxLength={300} defaultValue={rule?.note ?? ""} placeholder="Why this rule exists" className={field} dir="auto" /></label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving and re-applying…" : submitLabel}</Button>
        {state ? <span role="status" className={state.ok ? "text-status-ok" : "text-status-bad"}>{state.message}</span> : hint && <span role="status" data-testid="rule-preview" className={hint.ok ? "text-muted-foreground" : "text-status-bad"}>{hint.text}</span>}
      </div>
    </form>
  );
}
