-- CreateEnum
CREATE TYPE "StepUpMethod" AS ENUM ('TOTP', 'PIN');

-- CreateTable
CREATE TABLE "StepUpGrant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "method" "StepUpMethod" NOT NULL,
    "grantedAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "StepUpGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StepUpGrant_organizationId_memberId_subjectType_subjectId_idx" ON "StepUpGrant"("organizationId", "memberId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "StepUpGrant_organizationId_id_key" ON "StepUpGrant"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StepUpGrant" ADD CONSTRAINT "StepUpGrant_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

