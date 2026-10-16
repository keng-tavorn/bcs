-- CreateEnum
CREATE TYPE "OrganizationKind" AS ENUM ('PRODUCTION', 'SANDBOX');

-- CreateEnum
CREATE TYPE "RequestFlagKind" AS ENUM ('DUPLICATE', 'SPLIT');

-- CreateEnum
CREATE TYPE "WorkflowVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ApprovalStepKind" AS ENUM ('APPROVAL', 'REVIEW');

-- CreateEnum
CREATE TYPE "BudgetTransferKind" AS ENUM ('TRANSFER', 'INCREASE', 'DECREASE');

-- CreateEnum
CREATE TYPE "BudgetTransferStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BudgetOverrunStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'CONSUMED', 'LAPSED');

-- CreateEnum
CREATE TYPE "VerificationSubjectType" AS ENUM ('REQUEST', 'PURCHASE_ORDER');

-- CreateEnum
CREATE TYPE "ConfigPackageDirection" AS ENUM ('EXPORT', 'IMPORT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "BudgetSourceType" ADD VALUE 'BUDGET_TRANSFER';
ALTER TYPE "BudgetSourceType" ADD VALUE 'BUDGET_OVERRUN';

-- AlterEnum
ALTER TYPE "RoleCode" ADD VALUE 'DOA_ADMIN';

-- AlterTable
ALTER TABLE "ApprovalRoute" ADD COLUMN     "workflowVersionId" UUID;

-- AlterTable
ALTER TABLE "ApprovalStep" ADD COLUMN     "doaStepNo" INTEGER,
ADD COLUMN     "kind" "ApprovalStepKind" NOT NULL DEFAULT 'APPROVAL',
ADD COLUMN     "reviewGroups" JSONB;

-- AlterTable
ALTER TABLE "ApprovalTask" ADD COLUMN     "slotNo" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "workflowRuleCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "DoaVersion" ADD COLUMN     "withdrawalReason" TEXT,
ADD COLUMN     "withdrawalRequestedAt" TIMESTAMPTZ(6),
ADD COLUMN     "withdrawalRequestedById" UUID;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "kind" "OrganizationKind" NOT NULL DEFAULT 'PRODUCTION',
ADD COLUMN     "sandboxOfOrganizationId" UUID;

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "offAgreementReason" TEXT,
ADD COLUMN     "renewalOfRequestLineId" UUID,
ADD COLUMN     "sourceRequestId" UUID;

-- AlterTable
ALTER TABLE "RequestLine" ADD COLUMN     "budgetLineId" UUID,
ADD COLUMN     "catalogItemId" UUID,
ADD COLUMN     "priceAgreementId" UUID;

-- CreateTable
CREATE TABLE "RequestFlag" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "routeNo" INTEGER NOT NULL,
    "kind" "RequestFlagKind" NOT NULL,
    "matchedRequestIds" UUID[],
    "detail" JSONB NOT NULL,
    "acknowledgedReason" TEXT,
    "acknowledgedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "WorkflowVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(6),
    "changeReason" TEXT,
    "diffSummary" JSONB,
    "checksum" TEXT,
    "dryRunAt" TIMESTAMPTZ(6),
    "submittedById" UUID,
    "approvedById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "publishedAt" TIMESTAMPTZ(6),
    "withdrawnAt" TIMESTAMPTZ(6),
    "withdrawalRequestedAt" TIMESTAMPTZ(6),
    "withdrawalRequestedById" UUID,
    "withdrawalReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workflowVersionId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "requestTypeCodes" TEXT[],
    "when" JSONB NOT NULL,
    "reviewers" JSONB NOT NULL,
    "fallback" JSONB,
    "mode" "ApprovalQuorum" NOT NULL,
    "quorumCount" INTEGER,
    "slaBusinessMinutes" INTEGER NOT NULL,
    "descriptionTh" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTestCase" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workflowVersionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowTestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetTransfer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "kind" "BudgetTransferKind" NOT NULL,
    "fromBudgetLineId" UUID,
    "toBudgetLineId" UUID,
    "amountSatang" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "BudgetTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedById" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "currentRouteId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BudgetTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetOverrun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "requestId" UUID NOT NULL,
    "budgetLineId" UUID NOT NULL,
    "requestNetSatang" BIGINT NOT NULL,
    "shortfallSatang" BIGINT NOT NULL,
    "usedSatang" BIGINT NOT NULL DEFAULT 0,
    "returnedSatang" BIGINT NOT NULL DEFAULT 0,
    "returnedAfterUseSatang" BIGINT NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" "BudgetOverrunStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "submittedById" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL,
    "approvedAt" TIMESTAMPTZ(6),
    "lapsesAt" TIMESTAMPTZ(6),
    "consumedAt" TIMESTAMPTZ(6),
    "currentRouteId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BudgetOverrun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "uom" TEXT NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "isService" BOOLEAN NOT NULL DEFAULT false,
    "accountCode" TEXT,
    "whtIncomeType" TEXT,
    "refUnitPriceSatang" BIGINT NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceAgreement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "unitPriceSatang" BIGINT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "sourceRef" TEXT,
    "endedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PriceAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVerification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subjectType" "VerificationSubjectType" NOT NULL,
    "subjectId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "contentSha256" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL,
    "supersededAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DocumentVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigPackage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "direction" "ConfigPackageDirection" NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "summary" JSONB NOT NULL,
    "createdById" UUID NOT NULL,
    "createdObjects" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RequestFlag_organizationId_id_key" ON "RequestFlag"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RequestFlag_organizationId_requestId_routeNo_kind_key" ON "RequestFlag"("organizationId", "requestId", "routeNo", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_organizationId_id_key" ON "WorkflowVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_organizationId_code_versionNo_key" ON "WorkflowVersion"("organizationId", "code", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRule_organizationId_id_key" ON "WorkflowRule"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRule_organizationId_workflowVersionId_code_key" ON "WorkflowRule"("organizationId", "workflowVersionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTestCase_organizationId_id_key" ON "WorkflowTestCase"("organizationId", "id");

-- CreateIndex
CREATE INDEX "BudgetTransfer_organizationId_status_idx" ON "BudgetTransfer"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetTransfer_organizationId_id_key" ON "BudgetTransfer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetTransfer_organizationId_number_key" ON "BudgetTransfer"("organizationId", "number");

-- CreateIndex
CREATE INDEX "BudgetOverrun_organizationId_budgetLineId_status_idx" ON "BudgetOverrun"("organizationId", "budgetLineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetOverrun_organizationId_id_key" ON "BudgetOverrun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetOverrun_organizationId_number_key" ON "BudgetOverrun"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "budget_overrun_live_unique" ON "BudgetOverrun"("organizationId", "requestId", "budgetLineId") WHERE (status = ANY (ARRAY['PENDING_APPROVAL'::"BudgetOverrunStatus", 'APPROVED'::"BudgetOverrunStatus"]));

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_organizationId_id_key" ON "CatalogItem"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogItem_organizationId_code_key" ON "CatalogItem"("organizationId", "code");

-- CreateIndex
CREATE INDEX "PriceAgreement_organizationId_catalogItemId_idx" ON "PriceAgreement"("organizationId", "catalogItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceAgreement_organizationId_id_key" ON "PriceAgreement"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVerification_tokenHash_key" ON "DocumentVerification"("tokenHash");

-- CreateIndex
CREATE INDEX "DocumentVerification_organizationId_subjectType_subjectId_i_idx" ON "DocumentVerification"("organizationId", "subjectType", "subjectId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVerification_organizationId_id_key" ON "DocumentVerification"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ConfigPackage_organizationId_createdAt_idx" ON "ConfigPackage"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigPackage_organizationId_id_key" ON "ConfigPackage"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Request_organizationId_requesterMemberId_submittedAt_idx" ON "Request"("organizationId", "requesterMemberId", "submittedAt");

-- CreateIndex
CREATE INDEX "RequestLine_organizationId_catalogItemId_idx" ON "RequestLine"("organizationId", "catalogItemId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_sandboxOfOrganizationId_fkey" FOREIGN KEY ("sandboxOfOrganizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_sourceRequestId_fkey" FOREIGN KEY ("organizationId", "sourceRequestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_renewalOfRequestLineId_fkey" FOREIGN KEY ("organizationId", "renewalOfRequestLineId") REFERENCES "RequestLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_catalogItemId_fkey" FOREIGN KEY ("organizationId", "catalogItemId") REFERENCES "CatalogItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_priceAgreementId_fkey" FOREIGN KEY ("organizationId", "priceAgreementId") REFERENCES "PriceAgreement"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestFlag" ADD CONSTRAINT "RequestFlag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestFlag" ADD CONSTRAINT "RequestFlag_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestFlag" ADD CONSTRAINT "RequestFlag_organizationId_acknowledgedById_fkey" FOREIGN KEY ("organizationId", "acknowledgedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaVersion" ADD CONSTRAINT "DoaVersion_organizationId_withdrawalRequestedById_fkey" FOREIGN KEY ("organizationId", "withdrawalRequestedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_organizationId_approvedById_fkey" FOREIGN KEY ("organizationId", "approvedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_organizationId_withdrawalRequestedById_fkey" FOREIGN KEY ("organizationId", "withdrawalRequestedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowRule" ADD CONSTRAINT "WorkflowRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowRule" ADD CONSTRAINT "WorkflowRule_organizationId_workflowVersionId_fkey" FOREIGN KEY ("organizationId", "workflowVersionId") REFERENCES "WorkflowVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowTestCase" ADD CONSTRAINT "WorkflowTestCase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WorkflowTestCase" ADD CONSTRAINT "WorkflowTestCase_organizationId_workflowVersionId_fkey" FOREIGN KEY ("organizationId", "workflowVersionId") REFERENCES "WorkflowVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRoute" ADD CONSTRAINT "ApprovalRoute_organizationId_workflowVersionId_fkey" FOREIGN KEY ("organizationId", "workflowVersionId") REFERENCES "WorkflowVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT "BudgetTransfer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT "BudgetTransfer_organizationId_fromBudgetLineId_fkey" FOREIGN KEY ("organizationId", "fromBudgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT "BudgetTransfer_organizationId_toBudgetLineId_fkey" FOREIGN KEY ("organizationId", "toBudgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT "BudgetTransfer_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT "BudgetTransfer_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetOverrun" ADD CONSTRAINT "BudgetOverrun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetOverrun" ADD CONSTRAINT "BudgetOverrun_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetOverrun" ADD CONSTRAINT "BudgetOverrun_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetOverrun" ADD CONSTRAINT "BudgetOverrun_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetOverrun" ADD CONSTRAINT "BudgetOverrun_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CatalogItem" ADD CONSTRAINT "CatalogItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceAgreement" ADD CONSTRAINT "PriceAgreement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceAgreement" ADD CONSTRAINT "PriceAgreement_organizationId_catalogItemId_fkey" FOREIGN KEY ("organizationId", "catalogItemId") REFERENCES "CatalogItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceAgreement" ADD CONSTRAINT "PriceAgreement_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PriceAgreement" ADD CONSTRAINT "PriceAgreement_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DocumentVerification" ADD CONSTRAINT "DocumentVerification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConfigPackage" ADD CONSTRAINT "ConfigPackage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConfigPackage" ADD CONSTRAINT "ConfigPackage_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConfigPackage" ADD CONSTRAINT "ConfigPackage_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== S6 constraints, backfill and grants (docs/sub-specs/S6.md "Entity และ migration"; added after the generated part) =====

-- Every approval step before S6 is a DOA step: its doaStepNo is its step number (BR-WF-06), and every task is slot 1
UPDATE "ApprovalStep" SET "doaStepNo" = "stepNo" WHERE "doaStepNo" IS NULL;
ALTER TABLE "ApprovalStep" ADD CONSTRAINT approval_step_kind CHECK (
  ("kind" = 'APPROVAL' AND "doaStepNo" IS NOT NULL AND "doaStepNo" >= 1 AND "reviewGroups" IS NULL)
  OR ("kind" = 'REVIEW' AND "doaStepNo" IS NULL AND "reviewGroups" IS NOT NULL));
ALTER TABLE "ApprovalTask" ADD CONSTRAINT approval_task_slot_positive CHECK ("slotNo" >= 1);
-- An APPROVAL step written without its DOA step number (code and fixtures from before S6) is the DOA step of the same
-- number, as the backfill above; a route with a REVIEW step sets the number itself
CREATE OR REPLACE FUNCTION bcs_approval_step_doa_no() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" = 'APPROVAL' AND NEW."doaStepNo" IS NULL THEN
    NEW."doaStepNo" := NEW."stepNo";
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "ApprovalStep_doa_step_no" BEFORE INSERT ON "ApprovalStep"
  FOR EACH ROW EXECUTE FUNCTION bcs_approval_step_doa_no();

-- Workflow versions in effect never overlap for one code (as doa_no_overlap, §6.3 (5)); btree_gist comes from S2
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT workflow_no_overlap EXCLUDE USING gist (
  "organizationId" WITH =,
  "code" WITH =,
  tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz)) WITH &&
) WHERE ("status" IN ('PUBLISHED', 'SUPERSEDED'));
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT workflow_version_period CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT workflow_version_no_positive CHECK ("versionNo" >= 1);

-- A COUNT rule has a quorum of at least one; ALL and ANY have none (BR-WF-11)
ALTER TABLE "WorkflowRule" ADD CONSTRAINT workflow_rule_quorum CHECK (
  ("mode" = 'COUNT') = ("quorumCount" IS NOT NULL) AND ("quorumCount" IS NULL OR "quorumCount" >= 1));
ALTER TABLE "WorkflowRule" ADD CONSTRAINT workflow_rule_sla_positive CHECK ("slaBusinessMinutes" > 0);

-- Which lines each kind of transfer has (BR-BUD-10); money > 0 (ADR-018)
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT budget_transfer_lines CHECK (
  ("kind" = 'TRANSFER' AND "fromBudgetLineId" IS NOT NULL AND "toBudgetLineId" IS NOT NULL AND "fromBudgetLineId" <> "toBudgetLineId")
  OR ("kind" = 'INCREASE' AND "fromBudgetLineId" IS NULL AND "toBudgetLineId" IS NOT NULL)
  OR ("kind" = 'DECREASE' AND "fromBudgetLineId" IS NOT NULL AND "toBudgetLineId" IS NULL));
ALTER TABLE "BudgetTransfer" ADD CONSTRAINT budget_transfer_amount_positive CHECK ("amountSatang" > 0);

-- Over-budget amounts (BR-BUD-12 to 15, BR-BUD-18, INV-BUD-09)
ALTER TABLE "BudgetOverrun" ADD CONSTRAINT budget_overrun_money CHECK (
  "shortfallSatang" > 0 AND "requestNetSatang" >= 0 AND "usedSatang" >= 0 AND "returnedSatang" >= 0 AND "returnedAfterUseSatang" >= 0
  AND "usedSatang" + "returnedSatang" <= "shortfallSatang" AND "returnedAfterUseSatang" <= "usedSatang");

-- Catalogue and agreed prices (BR-PRC-06): periods of one item and supplier never overlap
ALTER TABLE "CatalogItem" ADD CONSTRAINT catalog_item_money_non_negative CHECK ("refUnitPriceSatang" >= 0);
ALTER TABLE "PriceAgreement" ADD CONSTRAINT price_agreement_money_positive CHECK ("unitPriceSatang" > 0);
ALTER TABLE "PriceAgreement" ADD CONSTRAINT price_agreement_period CHECK ("validTo" > "validFrom");
ALTER TABLE "PriceAgreement" ADD CONSTRAINT price_agreement_no_overlap EXCLUDE USING gist (
  "organizationId" WITH =,
  "catalogItemId" WITH =,
  "supplierId" WITH =,
  daterange("validFrom", "validTo", '[)') WITH &&
);

-- Document verification keeps only the hash of the token (BR-QR-01)
ALTER TABLE "DocumentVerification" ADD CONSTRAINT document_verification_token_hash CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "DocumentVerification" ADD CONSTRAINT document_verification_content_hash CHECK ("contentSha256" ~ '^[0-9a-f]{64}$');

-- Flags and configuration packages are append-only (BR-DUP-05, BR-UAT-02); bcs_forbid_mutation() comes from S1
CREATE TRIGGER request_flag_append_only BEFORE UPDATE OR DELETE ON "RequestFlag"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON "RequestFlag" FROM bcs_app;
GRANT SELECT, INSERT ON "RequestFlag" TO bcs_app;
ALTER TABLE "RequestFlag" ADD CONSTRAINT request_flag_route_positive CHECK ("routeNo" >= 1);
CREATE TRIGGER config_package_append_only BEFORE UPDATE OR DELETE ON "ConfigPackage"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON "ConfigPackage" FROM bcs_app;
GRANT SELECT, INSERT ON "ConfigPackage" TO bcs_app;
ALTER TABLE "ConfigPackage" ADD CONSTRAINT config_package_schema_positive CHECK ("schemaVersion" >= 1);

-- A sandbox belongs to one production organization, a production organization to none (BR-UAT-01)
ALTER TABLE "Organization" ADD CONSTRAINT organization_sandbox_of CHECK (
  ("kind" = 'SANDBOX') = ("sandboxOfOrganizationId" IS NOT NULL) AND ("sandboxOfOrganizationId" IS NULL OR "sandboxOfOrganizationId" <> "id"));
