-- CreateEnum
CREATE TYPE "AiPurpose" AS ENUM ('summary', 'period_summary', 'chat');

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "searchVector" tsvector;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "searchVector" tsvector,
ADD COLUMN     "webLink" TEXT;

-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN     "purpose" "AiPurpose" NOT NULL DEFAULT 'summary',
ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answerMarkdown" TEXT NOT NULL,
    "citations" JSONB NOT NULL DEFAULT '[]',
    "found" BOOLEAN NOT NULL DEFAULT false,
    "model" TEXT NOT NULL,
    "deep" BOOLEAN NOT NULL DEFAULT false,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "emailsRead" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "error" TEXT,
    "helpful" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatSession_orgId_userId_updatedAt_idx" ON "ChatSession"("orgId", "userId", "updatedAt");

-- CreateIndex
CREATE INDEX "ChatTurn_sessionId_createdAt_idx" ON "ChatTurn"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ChatTurn_createdAt_idx" ON "ChatTurn"("createdAt");

-- CreateIndex
CREATE INDEX "Thread_searchVector_idx" ON "Thread" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "Message_searchVector_idx" ON "Message" USING GIN ("searchVector");

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatTurn" ADD CONSTRAINT "ChatTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

