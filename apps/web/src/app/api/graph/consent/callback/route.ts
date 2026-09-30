import { NextResponse } from "next/server";
import { createLogger, getDb, getEnv, logAudit, verifyConsentState } from "@email-tracker/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const log = createLogger("consent");

/** Entra admin-consent redirect: ?admin_consent=True&tenant=<id>&state=<signed org> (or ?error=…). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const env = getEnv();
  const secret = process.env.AUTH_SECRET ?? "";
  const verified = verifyConsentState(url.searchParams.get("state"), secret);
  const back = (q: Record<string, string>) => NextResponse.redirect(new URL(`/companies?${new URLSearchParams(q).toString()}`, env.APP_URL || url.origin));
  if (!verified) return back({ consent: "invalid_state" });
  const error = url.searchParams.get("error");
  if (error) {
    log.warn("consent declined", { orgId: verified.orgId, error });
    return back({ consent: "error", detail: `${error}: ${url.searchParams.get("error_description") ?? ""}`.slice(0, 200) });
  }
  const tenant = url.searchParams.get("tenant");
  const granted = /^true$/i.test(url.searchParams.get("admin_consent") ?? "");
  if (!granted || !tenant || !/^[0-9a-f-]{36}$/i.test(tenant)) return back({ consent: "error", detail: "consent not granted" });
  const db = getDb();
  const org = await db.organization.findUnique({ where: { id: verified.orgId }, select: { id: true, slug: true, azureTenantId: true } });
  if (!org) return back({ consent: "error", detail: "unknown company" });
  await db.organization.update({ where: { id: org.id }, data: { azureTenantId: tenant, consentGrantedAt: new Date() } });
  await logAudit(db, { orgId: org.id, userEmail: "entra-admin-consent", action: "org.consent", targetType: "organization", targetId: org.id, before: { azureTenantId: org.azureTenantId }, after: { azureTenantId: tenant } });
  log.info("consent recorded", { org: org.slug });
  return back({ consent: "ok", company: org.slug });
}
