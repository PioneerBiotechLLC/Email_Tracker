import { undoRule } from "@/actions/rules";
import { ActionButton } from "@/components/shared/action-button";

/** Shown after a quick "Ignore this sender / domain": what happened, how many emails it touched, and Undo. */
export function RuleBanner({ orgId, rule, affected, returnTo }: { orgId: string; rule: string | undefined; affected: string | undefined; returnTo: string }) {
  if (!rule) return null;
  if (rule === "invalid") return <div className="rounded-md border px-3 py-2 text-sm status-waiting" role="status">That sender cannot be ignored (it has no usable address, or it belongs to this company).</div>;
  const n = Number(affected) || 0;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm status-replied" role="status" data-testid="rule-banner">
      <span>Ignore rule created: {n} email{n === 1 ? "" : "s"} affected. Manage rules in Settings → Exclusion rules.</span>
      <ActionButton action={undoRule.bind(null, orgId, rule, returnTo)} variant="outline" pendingLabel="Undoing…">Undo</ActionButton>
    </div>
  );
}
