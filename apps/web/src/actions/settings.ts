"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertSameOrg, getDb, logAudit, orgSettings, recomputeMailboxThreads, type Prisma } from "@email-tracker/core";
import { requireOrgAction } from "@/lib/session";

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Use HH:MM");

const hoursSchema = z.object({
  timezone: z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, "Unknown timezone"),
  workDays: z.array(z.coerce.number().int().min(0).max(6)).min(1, "Pick at least one work day"),
  workStart: hhmm,
  workEnd: hhmm,
  replySlaHours: z.coerce.number().positive().max(720).nullable(),
  summaryLanguage: z.enum(["en", "ar"]),
});

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function updateBusinessHours(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "settings.edit");
  const parsed = hoursSchema.safeParse({
    timezone: formData.get("timezone"),
    workDays: formData.getAll("workDays"),
    workStart: formData.get("workStart"),
    workEnd: formData.get("workEnd"),
    replySlaHours: formData.get("replySlaHours") ? formData.get("replySlaHours") : null,
    summaryLanguage: formData.get("summaryLanguage"),
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  const db = getDb();
  const before = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId } });
  await db.organization.update({ where: { id: ctx.orgId }, data: parsed.data });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.businessHours", targetType: "organization", targetId: ctx.orgId, before: { timezone: before.timezone, workDays: before.workDays, workStart: before.workStart, workEnd: before.workEnd, replySlaHours: before.replySlaHours, summaryLanguage: before.summaryLanguage }, after: parsed.data });
  // Business hours / SLA changes affect response times and overdue flags: recompute every thread.
  const mailboxes = await db.mailbox.findMany({ where: { orgId: ctx.orgId }, select: { id: true } });
  for (const mb of mailboxes) await recomputeMailboxThreads(db, mb.id);
  revalidatePath("/c/[slug]", "layout");
  return { ok: true, message: "Business hours saved and all threads recomputed." };
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #BE272C");
const brandingSchema = z.object({
  logoUrl: z.union([z.literal(""), z.string().url().max(500)]).transform((v) => v || null),
  primaryColor: hex,
  secondaryColor: hex,
  headingFont: z.enum(["merriweather", "playfair", "inter"]),
  bodyFont: z.enum(["source-sans", "inter", "noto-sans"]),
});

export async function updateBranding(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "settings.edit");
  const parsed = brandingSchema.safeParse({ logoUrl: formData.get("logoUrl") ?? "", primaryColor: formData.get("primaryColor"), secondaryColor: formData.get("secondaryColor"), headingFont: formData.get("headingFont"), bodyFont: formData.get("bodyFont") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  const db = getDb();
  const before = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { logoUrl: true, primaryColor: true, secondaryColor: true, headingFont: true, bodyFont: true } });
  await db.organization.update({ where: { id: ctx.orgId }, data: parsed.data });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.branding", targetType: "organization", targetId: ctx.orgId, before, after: parsed.data });
  revalidatePath("/c/[slug]", "layout");
  return { ok: true, message: "Branding saved." };
}

const digestSchema = z.object({
  digestRecipients: z.array(z.string().email()).max(50),
  digestHour: z.coerce.number().int().min(0).max(23),
  digestMinute: z.coerce.number().int().min(0).max(59),
});

export async function updateDigest(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "settings.edit");
  const time = String(formData.get("digestTime") ?? "08:00");
  const [h, m] = time.split(":");
  const recipients = String(formData.get("digestRecipients") ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const parsed = digestSchema.safeParse({ digestRecipients: recipients, digestHour: h, digestMinute: m });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const db = getDb();
  const before = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { digestRecipients: true, digestHour: true, digestMinute: true } });
  await db.organization.update({ where: { id: ctx.orgId }, data: parsed.data });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.digest", targetType: "organization", targetId: ctx.orgId, before, after: parsed.data });
  revalidatePath("/c/[slug]/settings", "page");
  return { ok: true, message: "Digest settings saved (sending starts in Phase 6)." };
}

export async function toggleMailbox(orgId: string, mailboxId: string, isActive: boolean) {
  const ctx = await requireOrgAction(orgId, "mailbox.toggle");
  const db = getDb();
  const mb = await db.mailbox.findUnique({ where: { id: mailboxId } });
  assertSameOrg(ctx, mb);
  await db.mailbox.update({ where: { id: mailboxId }, data: { isActive } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: isActive ? "mailbox.resume" : "mailbox.pause", targetType: "mailbox", targetId: mailboxId, before: { isActive: mb!.isActive }, after: { isActive } });
  revalidatePath("/c/[slug]/settings", "page");
  revalidatePath("/c/[slug]", "layout");
}

const storageSchema = z.object({ bodyStorage: z.enum(["full", "preview_only"]), retentionDays: z.coerce.number().int().min(30).max(3650) });

export async function updateStorage(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "settings.edit");
  const parsed = storageSchema.safeParse({ bodyStorage: formData.get("bodyStorage"), retentionDays: formData.get("retentionDays") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  const db = getDb();
  const org = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { bodyStorage: true, retentionDays: true, settings: true } });
  const before = { bodyStorage: org.bodyStorage, retentionDays: org.retentionDays, searchIndexBodies: orgSettings(org.settings).searchIndexBodies };
  const after = { ...parsed.data, searchIndexBodies: formData.get("searchIndexBodies") === "on" };
  const settings = { ...(org.settings && typeof org.settings === "object" && !Array.isArray(org.settings) ? org.settings : {}), searchIndexBodies: after.searchIndexBodies } as Prisma.InputJsonObject;
  await db.organization.update({ where: { id: ctx.orgId }, data: { ...parsed.data, settings } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.storage", targetType: "organization", targetId: ctx.orgId, before, after });
  revalidatePath("/c/[slug]/settings", "page");
  const notes = [
    parsed.data.bodyStorage === "preview_only" ? "New emails keep the preview only; existing bodies stay until the retention purge." : "",
    after.searchIndexBodies !== before.searchIndexBodies ? "The search setting applies to new emails now; run `pnpm search:reindex --all` to apply it to stored ones." : "",
  ].filter(Boolean);
  return { ok: true, message: ["Saved.", ...notes].join(" ") };
}
