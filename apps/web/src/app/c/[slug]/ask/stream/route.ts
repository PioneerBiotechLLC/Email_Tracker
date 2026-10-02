import { z } from "zod";
import { answerQuestion, createLogger, DEFAULT_ASK_LIMITS, getDb, hasAnthropicKey } from "@email-tracker/core";
import { chatEnabled } from "@/lib/chat-flag";
import type { AskStreamEvent } from "@/lib/data/ask";
import { getCompanyContext } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("ask");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish();
const bodySchema = z.object({ question: z.string().min(1).max(2000), sessionId: z.string().max(64).nullish(), deep: z.boolean().optional(), mailboxId: z.string().max(64).nullish(), after: day, before: day, threadId: z.string().max(64).nullish() });

/**
 * One question → newline-delimited JSON: progress lines while the tools run, then the answer.
 * The company and user come from the session (slug + membership); the body only carries the question and filters.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (!(await chatEnabled())) return new Response("Not found", { status: 404 });
  const { slug } = await params;
  const { ctx } = await getCompanyContext(slug);
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid request" }, { status: 400 });
  const { question, sessionId, deep, ...filters } = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AskStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        if (!hasAnthropicKey()) return send({ type: "error", message: "ANTHROPIC_API_KEY is not set, so questions cannot be answered." });
        // Leave room under maxDuration for the final model call and the database writes.
        const limits = { ...DEFAULT_ASK_LIMITS, deadlineAt: new Date(Date.now() + 35_000) };
        const r = await answerQuestion(getDb(), { ctx, question, sessionId, deep, filters }, { limits, onEvent: send });
        if (!r.ok) return send({ type: "error", message: r.message });
        send({ type: "answer", sessionId: r.sessionId, turn: { id: r.turnId, question: question.trim(), answerMarkdown: r.answerMarkdown, citations: r.citations, found: r.found, unverified: r.unverified, limitHit: r.limitHit, error: r.error, model: r.model, costUsd: r.costUsd, emailsRead: r.emailsRead, helpful: null } });
      } catch (err) {
        log.error("question failed", { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        send({ type: "error", message: "Something went wrong while answering. Please try again." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
