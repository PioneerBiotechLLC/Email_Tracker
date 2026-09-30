-- Multi-company: org slug/tenant consent/branding/storage, AppUser → Membership (data preserved).

-- CreateEnum
CREATE TYPE "BodyStorage" AS ENUM ('full', 'preview_only');

-- Organization: new columns. slug is backfilled from the domain before it becomes NOT NULL + unique.
ALTER TABLE "Organization" ADD COLUMN     "aiContext" TEXT,
ADD COLUMN     "bodyFont" TEXT NOT NULL DEFAULT 'source-sans',
ADD COLUMN     "bodyStorage" "BodyStorage" NOT NULL DEFAULT 'full',
ADD COLUMN     "consentGrantedAt" TIMESTAMP(3),
ADD COLUMN     "domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "headingFont" TEXT NOT NULL DEFAULT 'merriweather',
ADD COLUMN     "retentionDays" INTEGER NOT NULL DEFAULT 365,
ADD COLUMN     "secondaryColor" TEXT NOT NULL DEFAULT '#BE6B27',
ADD COLUMN     "slug" TEXT,
ALTER COLUMN "azureTenantId" DROP NOT NULL;

UPDATE "Organization"
SET "slug" = trim(both '-' from regexp_replace(lower(split_part("domain", '.', 1)), '[^a-z0-9]+', '-', 'g'))
WHERE "slug" IS NULL;
-- Resolve slug collisions (e.g. two orgs whose domains share a first label) by appending a counter.
WITH ranked AS (
  SELECT "id", "slug", row_number() OVER (PARTITION BY "slug" ORDER BY "createdAt", "id") AS rn FROM "Organization"
)
UPDATE "Organization" o SET "slug" = o."slug" || '-' || r.rn FROM ranked r WHERE o."id" = r."id" AND r.rn > 1;
UPDATE "Organization" SET "slug" = 'org-' || substr("id", 1, 8) WHERE "slug" IS NULL OR "slug" = '';
ALTER TABLE "Organization" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- Existing orgs already went through admin consent when their mailboxes were added.
UPDATE "Organization" SET "consentGrantedAt" = "createdAt" WHERE "azureTenantId" IS NOT NULL AND "azureTenantId" <> '' AND "consentGrantedAt" IS NULL;

-- Mailbox
ALTER TABLE "Mailbox" ADD COLUMN     "syncLockedAt" TIMESTAMP(3);

-- Membership table
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Membership_orgId_idx" ON "Membership"("orgId");
CREATE UNIQUE INDEX "Membership_userId_orgId_key" ON "Membership"("userId", "orgId");

-- Move every existing user into a membership for their org (same role) BEFORE dropping the column.
INSERT INTO "Membership" ("id", "userId", "orgId", "role", "createdAt")
SELECT 'mem_' || u."id", u."id", u."orgId", u."role", u."createdAt" FROM "AppUser" u;

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AppUser: drop org/role (now in Membership), add owner flag
ALTER TABLE "AppUser" DROP CONSTRAINT "AppUser_orgId_fkey";
ALTER TABLE "AppUser" DROP COLUMN "orgId",
DROP COLUMN "role",
ADD COLUMN     "isOwner" BOOLEAN NOT NULL DEFAULT false;
