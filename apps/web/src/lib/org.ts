import "server-only";
import { cache } from "react";
import { getDb } from "@email-tracker/core";

/** Org settings and mailboxes for the layout and filters (memoized per request). */
export const getOrgContext = cache(async (orgId: string) => {
  const db = getDb();
  const [org, mailboxes] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: orgId } }),
    db.mailbox.findMany({ where: { orgId }, orderBy: { emailAddress: "asc" }, select: { id: true, emailAddress: true, displayName: true, isActive: true, lastSyncedAt: true, lastSyncError: true, lastSyncErrorAt: true, aliases: true } }),
  ]);
  return { org, mailboxes };
});

export type OrgContext = Awaited<ReturnType<typeof getOrgContext>>;
