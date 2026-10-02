import type { Prisma, PrismaClient } from "../db.js";

export interface AuditEntry {
  orgId: string;
  userEmail: string;
  action: string;
  targetType: "thread" | "organization" | "mailbox" | "user" | "exclusion_rule" | "chat";
  targetId: string;
  before?: unknown;
  after?: unknown;
}

/** Records a dashboard action. Never include email bodies or summaries in before/after. */
export async function logAudit(db: PrismaClient, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      orgId: e.orgId,
      userEmail: e.userEmail,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
