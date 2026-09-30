"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, logAudit } from "@email-tracker/core";
import { requireOrgAction } from "@/lib/session";
import type { ActionResult } from "./settings";

const addSchema = z.object({ email: z.string().email().transform((e) => e.toLowerCase()), name: z.string().max(120).optional(), role: z.enum(["admin", "viewer"]) });

/** Adds a member to this company (creating the user if new; existing users keep their other memberships). */
export async function addUser(orgId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const ctx = await requireOrgAction(orgId, "users.manage");
  const parsed = addSchema.safeParse({ email: formData.get("email"), name: formData.get("name") || undefined, role: formData.get("role") });
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  const db = getDb();
  const u = await db.appUser.upsert({
    where: { email: parsed.data.email },
    create: { email: parsed.data.email, name: parsed.data.name, isActive: true },
    update: { isActive: true, ...(parsed.data.name ? { name: parsed.data.name } : {}) },
  });
  await db.membership.upsert({ where: { userId_orgId: { userId: u.id, orgId } }, create: { userId: u.id, orgId, role: parsed.data.role }, update: { role: parsed.data.role } });
  await logAudit(db, { orgId, userEmail: ctx.email, action: "user.add", targetType: "user", targetId: u.id, after: { email: u.email, role: parsed.data.role } });
  revalidatePath("/c/[slug]/settings", "page");
  return { ok: true, message: `${u.email} can now open this company as ${parsed.data.role}.` };
}

export async function setUserRole(orgId: string, userId: string, role: "admin" | "viewer") {
  const ctx = await requireOrgAction(orgId, "users.manage");
  if (userId === ctx.userId && role !== "admin") throw new Error("You cannot remove your own admin role.");
  const db = getDb();
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } } });
  if (!m) throw new Error("That user is not a member of this company.");
  await db.membership.update({ where: { id: m.id }, data: { role } });
  await logAudit(db, { orgId, userEmail: ctx.email, action: "user.role", targetType: "user", targetId: userId, before: { role: m.role }, after: { role } });
  revalidatePath("/c/[slug]/settings", "page");
}

/** Removes the membership only; the person keeps access to their other companies. */
export async function removeUser(orgId: string, userId: string) {
  const ctx = await requireOrgAction(orgId, "users.manage");
  if (userId === ctx.userId) throw new Error("You cannot remove yourself.");
  const db = getDb();
  const m = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, include: { user: { select: { email: true } } } });
  if (!m) return;
  await db.membership.delete({ where: { id: m.id } });
  await logAudit(db, { orgId, userEmail: ctx.email, action: "user.remove", targetType: "user", targetId: userId, before: { email: m.user.email, role: m.role } });
  revalidatePath("/c/[slug]/settings", "page");
}
