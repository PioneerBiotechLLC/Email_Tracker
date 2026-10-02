"use server";
import { notFound } from "next/navigation";
import { getDb } from "@email-tracker/core";
import { chatEnabled } from "@/lib/chat-flag";
import { requireOrgAction } from "@/lib/session";

/** Thumbs up / down on an answer (null clears it). Only the user who asked can rate it. */
export async function setTurnFeedback(orgId: string, turnId: string, helpful: boolean | null) {
  if (!(await chatEnabled())) notFound();
  const ctx = await requireOrgAction(orgId, "chat.ask");
  await getDb().chatTurn.updateMany({ where: { id: turnId, session: { orgId: ctx.orgId, userId: ctx.userId } }, data: { helpful } });
}
