-- CreateEnum
CREATE TYPE "AssistantLearningKind" AS ENUM ('ACCOUNT_CODE');

-- CreateTable
CREATE TABLE "AssistantLearning" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "AssistantLearningKind" NOT NULL,
    "supplierTaxId" TEXT NOT NULL,
    "categoryCode" VARCHAR(100) NOT NULL DEFAULT '',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "forgottenAt" TIMESTAMPTZ(6),
    "updatedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssistantLearning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantLearning_organizationId_id_key" ON "AssistantLearning"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantLearning_organizationId_kind_supplierTaxId_categor_key" ON "AssistantLearning"("organizationId", "kind", "supplierTaxId", "categoryCode");

-- AddForeignKey
ALTER TABLE "AssistantLearning" ADD CONSTRAINT "AssistantLearning_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssistantLearning" ADD CONSTRAINT "AssistantLearning_organizationId_updatedById_fkey" FOREIGN KEY ("organizationId", "updatedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
