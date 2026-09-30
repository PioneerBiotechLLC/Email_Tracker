import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed `state` for the Entra admin-consent redirect, so the callback can trust
 * which company the consent belongs to. Format: base64url(orgId.timestamp.signature).
 */
export function signConsentState(orgId: string, secret: string, now = Date.now()): string {
  const payload = `${orgId}.${now}`;
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyConsentState(state: string | null | undefined, secret: string, maxAgeMs = 60 * 60 * 1000, now = Date.now()): { orgId: string } | null {
  if (!state) return null;
  let decoded: string;
  try {
    const buf = Buffer.from(state, "base64url");
    if (buf.toString("base64url") !== state) return null; // non-canonical / tampered encoding
    decoded = buf.toString("utf8");
  } catch { return null; }
  const parts = decoded.split(".");
  if (parts.length !== 3) return null;
  const [orgId, ts, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${orgId}.${ts}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const issued = Number(ts);
  if (!Number.isFinite(issued) || now - issued > maxAgeMs || issued > now + 60_000) return null;
  return { orgId };
}

/** Admin-consent URL for a company's tenant ("organizations" when the tenant is not known yet). */
export function adminConsentUrl(opts: { clientId: string; redirectUri: string; state: string; tenantId?: string | null }): string {
  const tenant = opts.tenantId?.trim() || "organizations";
  const q = new URLSearchParams({ client_id: opts.clientId, redirect_uri: opts.redirectUri, state: opts.state });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?${q.toString()}`;
}
