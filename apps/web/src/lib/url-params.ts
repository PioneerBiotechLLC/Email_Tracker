export type SearchParams = Record<string, string | string[] | undefined>;

/** Rebuilds a query string from the current params plus overrides (null removes a key). */
export function withParams(sp: SearchParams | URLSearchParams, overrides: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  if (sp instanceof URLSearchParams) sp.forEach((v, k) => q.set(k, v));
  else for (const [k, v] of Object.entries(sp)) if (typeof v === "string") q.set(k, v);
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
