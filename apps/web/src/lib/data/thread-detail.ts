import "server-only";
import { assertSameOrg, getDb, readBody, type SessionContext } from "@email-tracker/core";

/** Thread + decrypted messages. Bodies only ever leave the server on this page. */
export async function getThreadDetail(ctx: SessionContext, threadId: string) {
  const db = getDb();
  const thread = await db.thread.findUnique({
    where: { id: threadId },
    include: {
      mailbox: { select: { id: true, orgId: true, emailAddress: true, displayName: true, aliases: true } },
      // the thread this one is a copy of (same emails tracked in another mailbox of the company)
      duplicateOf: { select: { id: true, mailbox: { select: { emailAddress: true } } } },
    },
  });
  if (!thread) return null;
  assertSameOrg(ctx, thread.mailbox);
  const messages = await db.message.findMany({
    where: { threadId },
    orderBy: { receivedAt: "asc" },
    include: {
      repliedBy: { select: { id: true, receivedAt: true, sentAt: true, fromAddress: true, mailbox: { select: { emailAddress: true } } } },
      duplicateOf: { select: { threadId: true, mailbox: { select: { emailAddress: true } } } },
      duplicates: { select: { threadId: true, mailbox: { select: { emailAddress: true } } } },
    },
  });
  return {
    thread,
    messages: messages.map((m) => {
      let body: string | null = null;
      try { body = readBody(m); } catch { body = "(body cannot be decrypted with the current DATA_ENCRYPTION_KEY)"; }
      const { bodyText: _b, bodyEncrypted: _e, ...rest } = m;
      return { ...rest, body: body ?? m.bodyPreview ?? "" };
    }),
  };
}

export type ThreadDetail = NonNullable<Awaited<ReturnType<typeof getThreadDetail>>>;
