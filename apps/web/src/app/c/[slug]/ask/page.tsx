import { notFound } from "next/navigation";
import { getDb, getEnv, MAX_TURNS_PER_SESSION, priceFor } from "@email-tracker/core";
import { AskChat } from "@/components/ask/ask-chat";
import { chatEnabled } from "@/lib/chat-flag";
import { defaultAskRange, getAskSession, getAskSessions } from "@/lib/data/ask";
import { formatDateTime } from "@/lib/format";
import { getCompanyContext } from "@/lib/session";

export const metadata = { title: "Ask" };

export default async function AskPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ s?: string; thread?: string; q?: string }> }) {
  if (!(await chatEnabled())) notFound();
  const { slug } = await params;
  const sp = await searchParams;
  const { ctx, org, mailboxes } = await getCompanyContext(slug);
  const now = new Date();
  const [sessions, session, thread] = await Promise.all([
    getAskSessions(ctx),
    sp.s ? getAskSession(ctx, sp.s) : null,
    sp.thread ? getDb().thread.findFirst({ where: { id: sp.thread, mailbox: { orgId: ctx.orgId } }, select: { id: true, subject: true } }) : null,
  ]);
  if (sp.s && !session) notFound();
  const env = getEnv();
  const chat = priceFor(env.ANTHROPIC_CHAT_MODEL);
  const deep = priceFor(env.ANTHROPIC_CHAT_DEEP_MODEL);
  // Asking about one thread searches that whole thread, whatever its dates.
  const defaultRange = thread ? { after: "", before: "" } : defaultAskRange(now, org.timezone);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Ask</h1>
      <AskChat
        key={session?.id ?? "new"}
        slug={slug}
        orgId={org.id}
        sessions={sessions.map((s) => ({ id: s.id, title: s.title, when: formatDateTime(s.updatedAt, org.timezone, now) }))}
        session={session}
        mailboxes={mailboxes.map((m) => ({ id: m.id, emailAddress: m.emailAddress }))}
        thread={thread}
        initialQuestion={(sp.q ?? "").slice(0, 2000)}
        models={{ chat: env.ANTHROPIC_CHAT_MODEL, deep: env.ANTHROPIC_CHAT_DEEP_MODEL, deepCostFactor: chat && deep ? Math.round((deep.input / chat.input) * 10) / 10 : 2 }}
        maxTurns={MAX_TURNS_PER_SESSION}
        defaultRange={defaultRange}
      />
    </div>
  );
}
