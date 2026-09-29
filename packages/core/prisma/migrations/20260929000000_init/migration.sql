-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('awaiting_us', 'awaiting_them', 'no_reply_needed', 'closed');

-- CreateEnum
CREATE TYPE "ThreadCategory" AS ENUM ('customer', 'supplier', 'internal', 'regulatory', 'finance', 'newsletter', 'notification', 'other');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "MailFolder" AS ENUM ('inbox', 'sent', 'other');

-- CreateEnum
CREATE TYPE "ReplyMethod" AS ENUM ('outlook_verb', 'header_match', 'conversation_match');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'viewer');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "azureTenantId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
    "summaryLanguage" TEXT NOT NULL DEFAULT 'en',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "displayName" TEXT,
    "graphUserId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "inboxDeltaLink" TEXT,
    "sentDeltaLink" TEXT,
    "subscriptionId" TEXT,
    "subscriptionExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "normalizedSubject" TEXT NOT NULL,
    "firstMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "participants" JSONB NOT NULL DEFAULT '[]',
    "status" "ThreadStatus" NOT NULL DEFAULT 'awaiting_us',
    "needsReply" BOOLEAN NOT NULL DEFAULT true,
    "category" "ThreadCategory" NOT NULL DEFAULT 'other',
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "summary" TEXT,
    "summaryLang" TEXT,
    "keyPoints" JSONB,
    "asks" JSONB,
    "nextAction" TEXT,
    "summaryUpdatedAt" TIMESTAMP(3),
    "summaryMessageCount" INTEGER NOT NULL DEFAULT 0,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "direction" "Direction" NOT NULL,
    "folder" "MailFolder" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddresses" JSONB NOT NULL DEFAULT '[]',
    "ccAddresses" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "bodyPreview" TEXT,
    "bodyText" TEXT,
    "bodyEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "hasAttachments" BOOLEAN NOT NULL DEFAULT false,
    "importance" TEXT NOT NULL DEFAULT 'normal',
    "isAutoReply" BOOLEAN NOT NULL DEFAULT false,
    "lastVerb" INTEGER,
    "lastVerbAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "repliedByMessageId" TEXT,
    "replyMethod" "ReplyMethod",
    "responseMinutes" INTEGER,
    "responseBusinessMinutes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DigestLog" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipients" JSONB NOT NULL,
    "content" TEXT NOT NULL,

    CONSTRAINT "DigestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_domain_key" ON "Organization"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_emailAddress_key" ON "Mailbox"("emailAddress");

-- CreateIndex
CREATE INDEX "Thread_mailboxId_status_idx" ON "Thread"("mailboxId", "status");

-- CreateIndex
CREATE INDEX "Thread_mailboxId_normalizedSubject_idx" ON "Thread"("mailboxId", "normalizedSubject");

-- CreateIndex
CREATE INDEX "Thread_mailboxId_lastMessageAt_idx" ON "Thread"("mailboxId", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Thread_mailboxId_conversationId_key" ON "Thread"("mailboxId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_graphMessageId_key" ON "Message"("graphMessageId");

-- CreateIndex
CREATE INDEX "Message_mailboxId_conversationId_idx" ON "Message"("mailboxId", "conversationId");

-- CreateIndex
CREATE INDEX "Message_threadId_receivedAt_idx" ON "Message"("threadId", "receivedAt");

-- CreateIndex
CREATE INDEX "Message_internetMessageId_idx" ON "Message"("internetMessageId");

-- CreateIndex
CREATE INDEX "Message_mailboxId_direction_repliedAt_idx" ON "Message"("mailboxId", "direction", "repliedAt");

-- CreateIndex
CREATE INDEX "Message_mailboxId_direction_receivedAt_idx" ON "Message"("mailboxId", "direction", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_repliedByMessageId_fkey" FOREIGN KEY ("repliedByMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DigestLog" ADD CONSTRAINT "DigestLog_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

