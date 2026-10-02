import "server-only";
import { exclusionReason, getDb } from "@email-tracker/core";

/** Badge text for each `excludedBy` value (a rule id or "auto:<signal>"), with one query for the rules involved. */
export async function exclusionReasons(excludedBy: (string | null)[]): Promise<Map<string, string>> {
  const keys = [...new Set(excludedBy.filter((k): k is string => !!k))];
  const ruleIds = keys.filter((k) => !k.startsWith("auto:"));
  const rules = ruleIds.length ? await getDb().exclusionRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, type: true, value: true, andSubjectContains: true } }) : [];
  const byId = new Map(rules.map((r) => [r.id, r]));
  return new Map(keys.map((k) => [k, exclusionReason(k, byId.get(k))]));
}
