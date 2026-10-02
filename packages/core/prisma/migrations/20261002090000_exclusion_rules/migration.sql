-- CreateEnum
CREATE TYPE "ExclusionRuleType" AS ENUM ('sender_email', 'sender_domain', 'subject_contains', 'subject_regex');

-- CreateEnum
CREATE TYPE "ExclusionAction" AS ENUM ('ignore', 'no_reply_needed');

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "exclusionAction" "ExclusionAction";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "autoSignals" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "excludedBy" TEXT,
ADD COLUMN     "exclusionAction" "ExclusionAction",
ADD COLUMN     "inferenceClassification" TEXT;

-- CreateTable
CREATE TABLE "ExclusionRule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "mailboxId" TEXT,
    "type" "ExclusionRuleType" NOT NULL,
    "value" TEXT NOT NULL,
    "andSubjectContains" TEXT,
    "action" "ExclusionAction" NOT NULL,
    "note" TEXT,
    "defaultKey" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ExclusionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExclusionRule_orgId_isActive_idx" ON "ExclusionRule"("orgId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ExclusionRule_orgId_defaultKey_key" ON "ExclusionRule"("orgId", "defaultKey");

-- CreateIndex
CREATE INDEX "Message_excludedBy_idx" ON "Message"("excludedBy");

-- AddForeignKey
ALTER TABLE "ExclusionRule" ADD CONSTRAINT "ExclusionRule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExclusionRule" ADD CONSTRAINT "ExclusionRule_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

