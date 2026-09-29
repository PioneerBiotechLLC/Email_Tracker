"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertSameOrg, getDb, logAudit } from "@email-tracker/core";
import { requireAction } from "@/lib/session";
import type { ActionResult } from "./settings";

const addSchema = z.object({ email: z.string().email().transform((e) => e.toLowerCase()), name: z.string().max(120).optional(), role: z.enum(["admin", "viewer"]) });

export async function addUser(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireAction("users.manage");
  const parsed = addSchema.safeParse({ email: formData.get("email"), name: formData.get("name") || undefined, role: formData.get("role") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  const db = getDb();
  const existing = await db.appUser.findUnique({ where: { email: parsed.data.email } });
  if (existing && existing.orgId !== ctx.orgId) return { ok: false, message: "That email already belongs to another organization." };
  const u = existing
    ? await db.appUser.update({ where: { id: existing.id }, data: { role: parsed.data.role, isActive: true, ...(parsed.data.name ? { name: parsed.data.name } : {}) } })
    : await db.appUser.create({ data: { orgId: ctx.orgId, email: parsed.data.email, name: parsed.data.name, role: parsed.data.role } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: existing ? "user.reactivate" : "user.add", targetType: "user", targetId: u.id, after: { email: u.email, role: u.role } });
  revalidatePath("/settings");
  return { ok: true, message: `${u.email} can now sign in as ${u.role}.` };
}

export async function setUserRole(userId: string, role: "admin" | "viewer") {
  const ctx = await requireAction("users.manage");
  const db = getDb();
  const u = await db.appUser.findUnique({ where: { id: userId } });
  assertSameOrg(ctx, u);
  if (u!.id === ctx.userId && role !== "admin") throw new Error("You cannot remove your own admin role.");
  await db.appUser.update({ where: { id: userId }, data: { role } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "user.role", targetType: "user", targetId: userId, before: { role: u!.role }, after: { role } });
  revalidatePath("/settings");
}

export async function setUserActive(userId: string, isActive: boolean) {
  const ctx = await requireAction("users.manage");
  const db = getDb();
  const u = await db.appUser.findUnique({ where: { id: userId } });
  assertSameOrg(ctx, u);
  if (u!.id === ctx.userId && !isActive) throw new Error("You cannot deactivate yourself.");
  await db.appUser.update({ where: { id: userId }, data: { isActive } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: isActive ? "user.reactivate" : "user.deactivate", targetType: "user", targetId: userId, before: { isActive: u!.isActive }, after: { isActive } });
  revalidatePath("/settings");
}
