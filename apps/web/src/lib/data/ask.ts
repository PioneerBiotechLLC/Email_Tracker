import "server-only";
import { getDb, type SessionContext, type SourceCitation } from "@email-tracker/core";

/** A stored question and answer, in the shape the chat renders (also what the stream route sends for a new answer). */
export interface AskTurn {
  id: string;
  question: string;
  answerMarkdown: string;
  citations: SourceCitation[];
  found: boolean;
  /** an answer was given but none of its sources could be confirmed */
  unverified: boolean;
  limitHit: string | null;
  error: string | null;
  model: string;
  costUsd: number;
  emailsRead: number;
  helpful: boolean | null;
}

/** Lines of the newline-delimited JSON stream the Ask route sends: progress while the tools run, then the answer or an error. */
export type AskStreamEvent = { type: "status"; text: string } | { type: "answer"; sessionId: string; turn: AskTurn } | { type: "error"; message: string };

/** The user's own chats, newest first. Nobody else's are ever listed, not even for admins. */
export async function getAskSessions(ctx: SessionContext) {
  return getDb().chatSession.findMany({ where: { orgId: ctx.orgId, userId: ctx.userId }, orderBy: { updatedAt: "desc" }, take: 50, select: { id: true, title: true, updatedAt: true } });
}

export async function getAskSession(ctx: SessionContext, sessionId: string): Promise<{ id: string; turns: AskTurn[] } | null> {
  const s = await getDb().chatSession.findFirst({ where: { id: sessionId, orgId: ctx.orgId, userId: ctx.userId }, select: { id: true, turns: { orderBy: { createdAt: "asc" } } } });
  if (!s) return null;
  return {
    id: s.id,
    turns: s.turns.map((t) => {
      const citations = t.citations as unknown as SourceCitation[];
      return { id: t.id, question: t.question, answerMarkdown: t.answerMarkdown, citations, found: t.found, unverified: t.found && !t.error && citations.length === 0, limitHit: null, error: t.error, model: t.model, costUsd: t.costUsd, emailsRead: t.emailsRead, helpful: t.helpful };
    }),
  };
}
