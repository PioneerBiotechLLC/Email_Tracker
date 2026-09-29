"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertSameOrg, getDb, logAudit, recomputeThread, summarizeThread, ForbiddenError, type Prisma } from "@email-tracker/core";
import { requireAction } from "@/lib/session";

async function loadThread(threadId: string, orgId: string) {
  const t = await getDb().thread.findUnique({ where: { id: threadId }, include: { mailbox: { select: { orgId: true } } } });
  assertSameOrg({ orgId }, t?.mailbox);
  return t!;
}

const snapshot = (t: { status: string; needsReply: boolean; needsReplyDecidedBy: string | null; closedBy: string | null; category: string; priority: string }) => ({
  status: t.status, needsReply: t.needsReply, needsReplyDecidedBy: t.needsReplyDecidedBy, closedBy: t.closedBy, category: t.category, priority: t.priority,
});

export async function closeThread(threadId: string) {
  const ctx = await requireAction("thread.close");
  const t = await loadThread(threadId, ctx.orgId);
  const db = getDb();
  await db.thread.update({ where: { id: threadId }, data: { status: "closed", closedAt: new Date(), closedBy: ctx.email, awaitingSince: null, overdueAt: null } });
  const after = await db.thread.findUniqueOrThrow({ where: { id: threadId } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "thread.close", targetType: "thread", targetId: threadId, before: snapshot(t), after: snapshot(after) });
  revalidatePath(`/threads/${threadId}`);
  revalidatePath("/threads");
}

export async function reopenThread(threadId: string) {
  const ctx = await requireAction("thread.reopen");
  const t = await loadThread(threadId, ctx.orgId);
  const db = getDb();
  await db.thread.update({ where: { id: threadId }, data: { status: "awaiting_us", closedAt: null, closedBy: null } });
  await recomputeThread(db, t.mailboxId, t.conversationId);
  const after = await db.thread.findUniqueOrThrow({ where: { id: threadId } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "thread.reopen", targetType: "thread", targetId: threadId, before: snapshot(t), after: snapshot(after) });
  revalidatePath(`/threads/${threadId}`);
  revalidatePath("/threads");
}

/** User decision on needsReply: sticky until a new inbound message arrives (Phase 3 rules). */
export async function setNeedsReply(threadId: string, needsReply: boolean) {
  const ctx = await requireAction("thread.needsReply");
  const t = await loadThread(threadId, ctx.orgId);
  const db = getDb();
  await db.thread.update({
    where: { id: threadId },
    data: { needsReply, needsReplyDecidedBy: "user", needsReplyDecidedAt: new Date(), ...(needsReply ? { status: t.status === "no_reply_needed" ? "awaiting_us" : t.status } : { status: t.status === "closed" ? "closed" : "no_reply_needed", awaitingSince: null, overdueAt: null }) },
  });
  await recomputeThread(db, t.mailboxId, t.conversationId);
  const after = await db.thread.findUniqueOrThrow({ where: { id: threadId } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: needsReply ? "thread.needsReply" : "thread.noReplyNeeded", targetType: "thread", targetId: threadId, before: snapshot(t), after: snapshot(after) });
  revalidatePath(`/threads/${threadId}`);
  revalidatePath("/threads");
}

export async function resummarizeThread(threadId: string) {
  const ctx = await requireAction("thread.resummarize");
  const t = await loadThread(threadId, ctx.orgId);
  const db = getDb();
  let outcome: string;
  let detail = "";
  try {
    const r = await summarizeThread(threadId, { force: true });
    outcome = r.outcome;
    detail = r.outcome === "summarized" ? `cost $${(r.costUsd ?? 0).toFixed(4)}` : (r.reason ?? "");
  } catch (err) {
    outcome = "error";
    detail = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
  }
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "thread.resummarize", targetType: "thread", targetId: threadId, before: { summaryMessageCount: t.summaryMessageCount }, after: { outcome, detail } });
  revalidatePath(`/threads/${threadId}`);
  redirect(`/threads/${threadId}?ai=${encodeURIComponent(outcome)}&detail=${encodeURIComponent(detail)}`);
}

export async function classifyThread(threadId: string, formData: FormData) {
  const ctx = await requireAction("thread.classify");
  const t = await loadThread(threadId, ctx.orgId);
  const category = String(formData.get("category") ?? "");
  const priority = String(formData.get("priority") ?? "");
  const data: Prisma.ThreadUpdateInput = {};
  if (category && category !== t.category) { data.category = category as Prisma.ThreadUpdateInput["category"]; data.categoryManual = true; }
  if (priority && priority !== t.priority) { data.priority = priority as Prisma.ThreadUpdateInput["priority"]; data.priorityManual = true; }
  if (!Object.keys(data).length) return;
  const db = getDb();
  await db.thread.update({ where: { id: threadId }, data });
  const after = await db.thread.findUniqueOrThrow({ where: { id: threadId } });
  await logAudit(db, { orgId: ctx.orgId, userEmail: ctx.email, action: "thread.classify", targetType: "thread", targetId: threadId, before: snapshot(t), after: snapshot(after) });
  revalidatePath(`/threads/${threadId}`);
}

export { ForbiddenError };
