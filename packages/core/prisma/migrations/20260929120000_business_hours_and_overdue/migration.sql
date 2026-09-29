-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "replySlaHours" DOUBLE PRECISION,
ADD COLUMN     "workDays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4]::INTEGER[],
ADD COLUMN     "workEnd" TEXT NOT NULL DEFAULT '18:00',
ADD COLUMN     "workStart" TEXT NOT NULL DEFAULT '09:00';

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "awaitingSince" TIMESTAMP(3),
ADD COLUMN     "overdueAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Thread_mailboxId_status_overdueAt_idx" ON "Thread"("mailboxId", "status", "overdueAt");

