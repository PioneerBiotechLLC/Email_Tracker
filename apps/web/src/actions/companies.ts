"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { GraphProvider, ensureSubscription, getDb, isValidSlug, logAudit, reapplyExclusions, seedDefaultRules, slugify } from "@email-tracker/core";
import { requireOwner } from "@/lib/session";
import type { ActionResult } from "./settings";

/** Time budget for re-checking stored copies after a mailbox is added (the Graph calls before it take a few seconds of the request). */
const REAPPLY_SECONDS = 30;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #C2922F");
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM");
const companySchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().transform((s) => s.trim().toLowerCase()).refine(isValidSlug, "Slug: lowercase letters, digits and dashes"),
  domain: z.string().transform((s) => s.trim().toLowerCase()).refine((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d), "Primary email domain, e.g. pbio.tech"),
  domains: z.array(z.string()).max(10),
  azureTenantId: z.union([z.literal(""), z.string().regex(/^[0-9a-f-]{36}$/i, "Tenant ID must be a GUID")]).transform((v) => v || null),
  timezone: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone"),
  workDays: z.array(z.coerce.number().int().min(0).max(6)).min(1, "Pick at least one work day"),
  workStart: hhmm,
  workEnd: hhmm,
  replySlaHours: z.coerce.number().positive().max(720),
  summaryLanguage: z.enum(["en", "ar"]),
  logoUrl: z.union([z.literal(""), z.string().url().max(500)]).transform((v) => v || null),
  primaryColor: hex,
  secondaryColor: hex,
  headingFont: z.enum(["merriweather", "playfair", "inter"]),
  bodyFont: z.enum(["source-sans", "inter", "noto-sans"]),
  aiContext: z.string().max(2000).transform((v) => v.trim() || null),
});

function readCompany(formData: FormData) {
  const name = String(formData.get("name") ?? "");
  return companySchema.safeParse({
    name,
    slug: String(formData.get("slug") ?? "") || slugify(name),
    domain: formData.get("domain"),
    domains: String(formData.get("domains") ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    azureTenantId: String(formData.get("azureTenantId") ?? "").trim(),
    timezone: formData.get("timezone") || "Asia/Dubai",
    workDays: formData.getAll("workDays"),
    workStart: formData.get("workStart") || "09:00",
    workEnd: formData.get("workEnd") || "18:00",
    replySlaHours: formData.get("replySlaHours") || 24,
    summaryLanguage: formData.get("summaryLanguage") || "en",
    logoUrl: formData.get("logoUrl") ?? "",
    primaryColor: formData.get("primaryColor") || "#BE272C",
    secondaryColor: formData.get("secondaryColor") || "#BE6B27",
    headingFont: formData.get("headingFont") || "merriweather",
    bodyFont: formData.get("bodyFont") || "source-sans",
    aiContext: formData.get("aiContext") ?? "",
  });
}

export async function addCompany(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();
  const parsed = readCompany(formData);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const db = getDb();
  const clash = await db.organization.findFirst({ where: { OR: [{ slug: parsed.data.slug }, { domain: parsed.data.domain }] }, select: { id: true } });
  if (clash) return { ok: false, message: "A company with that slug or domain already exists." };
  const org = await db.organization.create({ data: { ...parsed.data, consentGrantedAt: parsed.data.azureTenantId ? new Date() : null } });
  await seedDefaultRules(db, org.id);
  await logAudit(db, { orgId: org.id, userEmail: owner.email, action: "org.create", targetType: "organization", targetId: org.id, after: { slug: org.slug, domain: org.domain } });
  revalidatePath("/companies");
  return { ok: true, message: `${org.name} created at /c/${org.slug}. Next: Connect Microsoft 365, then add mailboxes.` };
}

export async function updateCompany(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();
  const parsed = readCompany(formData);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const db = getDb();
  const before = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  const clash = await db.organization.findFirst({ where: { id: { not: orgId }, OR: [{ slug: parsed.data.slug }, { domain: parsed.data.domain }] }, select: { id: true } });
  if (clash) return { ok: false, message: "Another company already uses that slug or domain." };
  const { azureTenantId, ...rest } = parsed.data;
  await db.organization.update({ where: { id: orgId }, data: { ...rest, ...(azureTenantId && azureTenantId !== before.azureTenantId ? { azureTenantId, consentGrantedAt: new Date() } : {}) } });
  await logAudit(db, { orgId, userEmail: owner.email, action: "org.update", targetType: "organization", targetId: orgId, before: { slug: before.slug, domain: before.domain, azureTenantId: before.azureTenantId }, after: { slug: rest.slug, domain: rest.domain, azureTenantId: azureTenantId ?? before.azureTenantId } });
  revalidatePath("/companies");
  revalidatePath("/c/[slug]", "layout");
  return { ok: true, message: "Company saved." };
}

/** Adds a mailbox exactly like `pnpm mailbox add`: resolves the Graph user, stores aliases, subscribes to notifications. */
export async function addMailbox(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const owner = await requireOwner();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return { ok: false, message: "Enter a mailbox address." };
  const db = getDb();
  const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
  if (!org.azureTenantId) return { ok: false, message: "Connect Microsoft 365 first (admin consent records the tenant)." };
  try {
    const user = await new GraphProvider(org.azureTenantId).resolveUser(email);
    const aliases = Array.from(new Set([...user.proxyAddresses, user.mail ?? "", user.userPrincipalName].map((a) => a.toLowerCase()).filter((a) => a && a !== email)));
    const mb = await db.mailbox.upsert({
      where: { emailAddress: email },
      create: { orgId, emailAddress: email, displayName: user.displayName, graphUserId: user.id, aliases, isActive: true },
      update: { displayName: user.displayName, graphUserId: user.id, aliases, isActive: true },
    });
    if (mb.orgId !== orgId) return { ok: false, message: "That mailbox already belongs to another company." };
    await logAudit(db, { orgId, userEmail: owner.email, action: "mailbox.add", targetType: "mailbox", targetId: mb.id, after: { email } });
    const sub = await ensureSubscription(db, mb.id);
    // Stored emails addressed To this mailbox that the company's other mailboxes hold are Cc copies now: re-check them.
    const reapplied = await reapplyExclusions(db, orgId, { deadlineAt: new Date(Date.now() + REAPPLY_SECONDS * 1000) });
    revalidatePath("/companies");
    revalidatePath("/c/[slug]", "layout");
    const subMsg = sub.action === "skipped" ? `Live notifications skipped: ${sub.detail}.` : sub.action === "error" ? `Live notifications failed: ${sub.detail}.` : "Live notifications subscribed.";
    const rest = reapplied.partial ? ", then pnpm rules:reapply (re-checking the copies other mailboxes hold did not finish in time)" : "";
    return { ok: true, message: `Mailbox ${email} added. ${subMsg} Now run the backfill from your laptop: pnpm sync:once ${email}${rest}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: /403|Access|denied|policy/i.test(msg) ? `Graph refused access to ${email}: check admin consent and the Application Access Policy in that tenant (${msg.slice(0, 120)})` : `Could not resolve ${email} in Microsoft 365: ${msg.slice(0, 160)}` };
  }
}
