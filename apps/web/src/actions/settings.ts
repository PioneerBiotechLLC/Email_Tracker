"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertSameOrg, getDb, logAudit, recomputeMailboxThreads } from "@email-tracker/core";
import { requireAction } from "@/lib/session";

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

export async function updateBusinessHours(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireAction("settings.edit");
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
  revalidatePath("/", "layout");
  return { ok: true, message: "Business hours saved and all threads recomputed." };
}

const brandingSchema = z.object({
  logoUrl: z.union([z.literal(""), z.string().url().max(500)]).transform((v) => v || null),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #BE272C"),
});

export async function updateBranding(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireAction("settings.edit");
  const parsed = brandingSchema.safeParse({ logoUrl: formData.get("logoUrl") ?? "", primaryColor: formData.get("primaryColor") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  const db = getDb();
  const before = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { logoUrl: true, primaryColor: true } });
  await db.organization.update({ where: { id: ctx.orgId }, data: parsed.data });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.branding", targetType: "organization", targetId: ctx.orgId, before, after: parsed.data });
  revalidatePath("/", "layout");
  return { ok: true, message: "Branding saved." };
}

const digestSchema = z.object({
  digestRecipients: z.array(z.string().email()).max(50),
  digestHour: z.coerce.number().int().min(0).max(23),
  digestMinute: z.coerce.number().int().min(0).max(59),
});

export async function updateDigest(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireAction("settings.edit");
  const time = String(formData.get("digestTime") ?? "08:00");
  const [h, m] = time.split(":");
  const recipients = String(formData.get("digestRecipients") ?? "").split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const parsed = digestSchema.safeParse({ digestRecipients: recipients, digestHour: h, digestMinute: m });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const db = getDb();
  const before = await db.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { digestRecipients: true, digestHour: true, digestMinute: true } });
  await db.organization.update({ where: { id: ctx.orgId }, data: parsed.data });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "settings.digest", targetType: "organization", targetId: ctx.orgId, before, after: parsed.data });
  revalidatePath("/settings");
  return { ok: true, message: "Digest settings saved (sending starts in Phase 6)." };
}

export async function toggleMailbox(mailboxId: string, isActive: boolean) {
  const ctx = await requireAction("mailbox.toggle");
  const db = getDb();
  const mb = await db.mailbox.findUnique({ where: { id: mailboxId } });
  assertSameOrg(ctx, mb);
  await db.mailbox.update({ where: { id: mailboxId }, data: { isActive } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: isActive ? "mailbox.resume" : "mailbox.pause", targetType: "mailbox", targetId: mailboxId, before: { isActive: mb!.isActive }, after: { isActive } });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
}
