-- CreateEnum
CREATE TYPE "SummaryPeriod" AS ENUM ('day', 'week', 'month');

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "duplicateOfId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "internalRecipients" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "PeriodSummary" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "mailboxId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "period" "SummaryPeriod" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "language" TEXT NOT NULL,
    "overview" TEXT NOT NULL,
    "received" JSONB NOT NULL DEFAULT '[]',
    "sent" JSONB NOT NULL DEFAULT '[]',
    "needsAttention" JSONB NOT NULL DEFAULT '[]',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "threadCount" INTEGER NOT NULL DEFAULT 0,
    "includedCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeriodSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeriodSummary_orgId_scopeKey_period_createdAt_idx" ON "PeriodSummary"("orgId", "scopeKey", "period", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PeriodSummary_orgId_scopeKey_period_periodStart_key" ON "PeriodSummary"("orgId", "scopeKey", "period", "periodStart");

-- CreateIndex
CREATE INDEX "Thread_duplicateOfId_idx" ON "Thread"("duplicateOfId");

-- CreateIndex
CREATE INDEX "Message_duplicateOfId_idx" ON "Message"("duplicateOfId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodSummary" ADD CONSTRAINT "PeriodSummary_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PeriodSummary" ADD CONSTRAINT "PeriodSummary_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

