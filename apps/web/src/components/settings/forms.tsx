"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/actions/settings";

type Action = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

export function SettingsForm({ action, children, submitLabel = "Save" }: { action: Action; children: React.ReactNode; submitLabel?: string }) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} className="space-y-3 text-sm">
      {children}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
        {state && <span role="status" className={state.ok ? "text-status-ok" : "text-status-bad"}>{state.message}</span>}
      </div>
    </form>
  );
}

export const field = "mt-1 h-9 w-full rounded-md border bg-background px-2";
