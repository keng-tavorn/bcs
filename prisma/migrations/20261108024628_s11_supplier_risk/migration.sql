-- CreateEnum
CREATE TYPE "RiskTierCode" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RiskDomain" AS ENUM ('GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('NOT_ASSESSED', 'IN_PROGRESS', 'CURRENT', 'EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED');

-- CreateEnum
CREATE TYPE "WorkflowRuleScope" AS ENUM ('REQUEST', 'RISK_ASSESSMENT');

-- CreateEnum
CREATE TYPE "RiskQuestionnaireStatus" AS ENUM ('DRAFT', 'PENDING_PUBLISH', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "RiskQuestionKind" AS ENUM ('SINGLE_CHOICE');

-- CreateEnum
CREATE TYPE "RiskAssessmentStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'RETURNED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RiskAnswerSource" AS ENUM ('EXPLICIT', 'EVIDENCE', 'ON_BEHALF');

-- CreateEnum
CREATE TYPE "ReviewTaskStatus" AS ENUM ('OPEN', 'PASSED', 'RETURNED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReviewTaskQuorum" AS ENUM ('ALL');

-- CreateEnum
CREATE TYPE "ReviewTaskFallback" AS ENUM ('NONE', 'VACANT', 'CONFLICT');

-- CreateEnum
CREATE TYPE "ReviewTaskCancelWhy" AS ENUM ('STEP_DECIDED', 'ASSESSMENT_CANCELLED', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "RiskOverrideStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RiskReviewReason" AS ENUM ('SCHEDULED', 'STATUS_CHANGED', 'OVERRIDE_EXPIRED');

-- CreateEnum
CREATE TYPE "RiskReviewStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AiAgent" ADD VALUE 'RISK';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiPurpose" ADD VALUE 'RISK_ANSWER_DRAFT';
ALTER TYPE "AiPurpose" ADD VALUE 'RISK_FILE_SUMMARY';

-- AlterEnum
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'RISK_OVERRIDE';

-- AlterEnum
ALTER TYPE "DoaDocumentType" ADD VALUE 'RISK_OVERRIDE';

-- AlterEnum
ALTER TYPE "FileLinkKind" ADD VALUE 'RISK_EVIDENCE';

-- AlterEnum
ALTER TYPE "PortalInviteLinkPurpose" ADD VALUE 'RISK_QUESTIONNAIRE';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "riskGate" JSONB,
ADD COLUMN     "riskOverrideId" UUID;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "currentRiskAssessmentId" UUID,
ADD COLUMN     "riskAssessedAt" TIMESTAMPTZ(6),
ADD COLUMN     "riskStatus" "RiskStatus" NOT NULL DEFAULT 'NOT_ASSESSED',
ADD COLUMN     "riskTier" "RiskTierCode",
ADD COLUMN     "riskValidUntil" DATE;

-- AlterTable
ALTER TABLE "WorkflowRule" ADD COLUMN     "riskDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "scope" "WorkflowRuleScope" NOT NULL DEFAULT 'REQUEST';

-- CreateTable
CREATE TABLE "RiskTier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" "RiskTierCode" NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "minPoints" INTEGER NOT NULL,
    "reviewMonths" INTEGER NOT NULL,
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 30,
    "blocksPo" BOOLEAN NOT NULL DEFAULT false,
    "requiresExplicitAnswers" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" UUID NOT NULL,
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMPTZ(6),
    "pendingChange" JSONB,
    "pendingById" UUID,
    "pendingAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "screeningTierMap" JSONB NOT NULL,
    "highRiskCategories" TEXT[],
    "registryFlagBlocks" BOOLEAN NOT NULL,
    "mediumOverdueBlocks" BOOLEAN NOT NULL,
    "overrideChatButton" BOOLEAN NOT NULL,
    "updatedById" UUID NOT NULL,
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMPTZ(6),
    "pendingChange" JSONB,
    "pendingById" UUID,
    "pendingAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskQuestionnaire" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "RiskQuestionnaireStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(6),
    "changeReason" TEXT,
    "checksum" TEXT,
    "submittedById" UUID,
    "publishedById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "publishedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskQuestionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskQuestion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "questionnaireId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "domain" "RiskDomain" NOT NULL,
    "textTh" TEXT NOT NULL,
    "textEn" TEXT NOT NULL,
    "helpTh" TEXT,
    "helpEn" TEXT,
    "kind" "RiskQuestionKind" NOT NULL DEFAULT 'SINGLE_CHOICE',
    "options" JSONB NOT NULL,
    "appliesWhen" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "evidenceScopeRequired" BOOLEAN NOT NULL DEFAULT false,
    "evidenceScope" TEXT,
    "aiReadable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAssessment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "supplierId" UUID NOT NULL,
    "questionnaireId" UUID NOT NULL,
    "triggerRequestId" UUID,
    "triggerPoId" UUID,
    "screening" JSONB NOT NULL,
    "categoryCodes" TEXT[],
    "payeeType" "PayeeType" NOT NULL,
    "workScopes" TEXT[],
    "inherentTier" "RiskTierCode" NOT NULL,
    "pointsTotal" INTEGER,
    "tier" "RiskTierCode",
    "scoringSnapshot" JSONB,
    "lastActivityAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "RiskAssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "openedById" UUID NOT NULL,
    "filledOnBehalfById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "submittedByContactId" UUID,
    "completedAt" TIMESTAMPTZ(6),
    "completedOn" DATE,
    "validUntil" DATE,
    "remindOn" DATE,
    "returnReason" TEXT,
    "supersededById" UUID,
    "workflowVersionId" UUID,
    "reviewRound" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskAnswer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "questionCode" TEXT NOT NULL,
    "optionCode" TEXT,
    "source" "RiskAnswerSource" NOT NULL,
    "evidenceDocumentId" UUID,
    "points" INTEGER NOT NULL,
    "answeredAt" TIMESTAMPTZ(6) NOT NULL,
    "answeredByContactId" UUID,
    "answeredByMemberId" UUID,
    "agentActionId" UUID,
    "note" TEXT,
    "evidenceAiReadable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "assessmentId" UUID NOT NULL,
    "reviewRound" INTEGER NOT NULL,
    "workflowVersionId" UUID NOT NULL,
    "ruleCodes" TEXT[],
    "groupNo" INTEGER NOT NULL,
    "slotNo" INTEGER NOT NULL,
    "quorum" "ReviewTaskQuorum" NOT NULL DEFAULT 'ALL',
    "riskDomains" TEXT[],
    "assigneeMemberId" UUID NOT NULL,
    "delegatorMemberId" UUID,
    "fallbackUsed" "ReviewTaskFallback" NOT NULL DEFAULT 'NONE',
    "status" "ReviewTaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAt" TIMESTAMPTZ(6) NOT NULL,
    "dueAt" TIMESTAMPTZ(6) NOT NULL,
    "remindAt" TIMESTAMPTZ(6),
    "escalateAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "decidedById" UUID,
    "reasonCommentId" UUID,
    "cancelledWhy" "ReviewTaskCancelWhy",
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ReviewTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskOverride" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "supplierId" UUID NOT NULL,
    "assessmentId" UUID,
    "poId" UUID,
    "reason" TEXT NOT NULL,
    "capGrossSatang" BIGINT NOT NULL,
    "expiresOn" DATE NOT NULL,
    "requestedById" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "status" "RiskOverrideStatus" NOT NULL DEFAULT 'DRAFT',
    "currentRouteId" UUID,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "usedGrossSatang" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskReview" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "tier" "RiskTierCode",
    "reason" "RiskReviewReason" NOT NULL,
    "dueAt" TIMESTAMPTZ(6) NOT NULL,
    "remindedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "completedByAssessmentId" UUID,
    "status" "RiskReviewStatus" NOT NULL DEFAULT 'OPEN',
    "sourceAssessmentId" UUID,
    "sourceOverrideId" UUID,
    "registryFlag" "RegistryFlag",
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RiskReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RiskTier_organizationId_id_key" ON "RiskTier"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskTier_organizationId_code_key" ON "RiskTier"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RiskPolicy_organizationId_id_key" ON "RiskPolicy"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskPolicy_organizationId_key" ON "RiskPolicy"("organizationId");

-- CreateIndex
CREATE INDEX "RiskQuestionnaire_organizationId_status_effectiveFrom_idx" ON "RiskQuestionnaire"("organizationId", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RiskQuestionnaire_organizationId_id_key" ON "RiskQuestionnaire"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskQuestionnaire_organizationId_code_versionNo_key" ON "RiskQuestionnaire"("organizationId", "code", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "RiskQuestion_organizationId_id_key" ON "RiskQuestion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskQuestion_organizationId_questionnaireId_code_key" ON "RiskQuestion"("organizationId", "questionnaireId", "code");

-- CreateIndex
CREATE INDEX "RiskAssessment_organizationId_supplierId_status_idx" ON "RiskAssessment"("organizationId", "supplierId", "status");

-- CreateIndex
CREATE INDEX "RiskAssessment_organizationId_status_validUntil_idx" ON "RiskAssessment"("organizationId", "status", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessment_organizationId_id_key" ON "RiskAssessment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAssessment_organizationId_number_key" ON "RiskAssessment"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "risk_assessment_one_open" ON "RiskAssessment"("organizationId", "supplierId") WHERE (status = ANY (ARRAY['DRAFT'::"RiskAssessmentStatus", 'IN_REVIEW'::"RiskAssessmentStatus", 'RETURNED'::"RiskAssessmentStatus"]));

-- CreateIndex
CREATE UNIQUE INDEX "risk_assessment_one_completed" ON "RiskAssessment"("organizationId", "supplierId") WHERE (status = 'COMPLETED'::"RiskAssessmentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAnswer_organizationId_id_key" ON "RiskAnswer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskAnswer_organizationId_assessmentId_questionCode_key" ON "RiskAnswer"("organizationId", "assessmentId", "questionCode");

-- CreateIndex
CREATE INDEX "ReviewTask_organizationId_assigneeMemberId_status_idx" ON "ReviewTask"("organizationId", "assigneeMemberId", "status");

-- CreateIndex
CREATE INDEX "ReviewTask_organizationId_assessmentId_status_idx" ON "ReviewTask"("organizationId", "assessmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTask_organizationId_id_key" ON "ReviewTask"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewTask_organizationId_assessmentId_reviewRound_slotNo_key" ON "ReviewTask"("organizationId", "assessmentId", "reviewRound", "slotNo");

-- CreateIndex
CREATE INDEX "RiskOverride_organizationId_supplierId_status_expiresOn_idx" ON "RiskOverride"("organizationId", "supplierId", "status", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOverride_organizationId_id_key" ON "RiskOverride"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RiskOverride_organizationId_number_key" ON "RiskOverride"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "risk_override_one_open" ON "RiskOverride"("organizationId", "supplierId") WHERE (status = ANY (ARRAY['DRAFT'::"RiskOverrideStatus", 'PENDING_APPROVAL'::"RiskOverrideStatus", 'RETURNED'::"RiskOverrideStatus"]));

-- CreateIndex
CREATE INDEX "RiskReview_organizationId_status_dueAt_idx" ON "RiskReview"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "RiskReview_organizationId_id_key" ON "RiskReview"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_review_one_open" ON "RiskReview"("organizationId", "supplierId", "reason") WHERE (status = 'OPEN'::"RiskReviewStatus");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_currentRiskAssessmentId_fkey" FOREIGN KEY ("organizationId", "currentRiskAssessmentId") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_riskOverrideId_fkey" FOREIGN KEY ("organizationId", "riskOverrideId") REFERENCES "RiskOverride"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskTier" ADD CONSTRAINT "RiskTier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskTier" ADD CONSTRAINT "RiskTier_organizationId_updatedById_fkey" FOREIGN KEY ("organizationId", "updatedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskTier" ADD CONSTRAINT "RiskTier_organizationId_confirmedById_fkey" FOREIGN KEY ("organizationId", "confirmedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskTier" ADD CONSTRAINT "RiskTier_organizationId_pendingById_fkey" FOREIGN KEY ("organizationId", "pendingById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskPolicy" ADD CONSTRAINT "RiskPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskPolicy" ADD CONSTRAINT "RiskPolicy_organizationId_updatedById_fkey" FOREIGN KEY ("organizationId", "updatedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskPolicy" ADD CONSTRAINT "RiskPolicy_organizationId_confirmedById_fkey" FOREIGN KEY ("organizationId", "confirmedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskPolicy" ADD CONSTRAINT "RiskPolicy_organizationId_pendingById_fkey" FOREIGN KEY ("organizationId", "pendingById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskQuestionnaire" ADD CONSTRAINT "RiskQuestionnaire_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskQuestionnaire" ADD CONSTRAINT "RiskQuestionnaire_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskQuestionnaire" ADD CONSTRAINT "RiskQuestionnaire_organizationId_publishedById_fkey" FOREIGN KEY ("organizationId", "publishedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskQuestion" ADD CONSTRAINT "RiskQuestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskQuestion" ADD CONSTRAINT "RiskQuestion_organizationId_questionnaireId_fkey" FOREIGN KEY ("organizationId", "questionnaireId") REFERENCES "RiskQuestionnaire"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_questionnaireId_fkey" FOREIGN KEY ("organizationId", "questionnaireId") REFERENCES "RiskQuestionnaire"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_triggerRequestId_fkey" FOREIGN KEY ("organizationId", "triggerRequestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_triggerPoId_fkey" FOREIGN KEY ("organizationId", "triggerPoId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_openedById_fkey" FOREIGN KEY ("organizationId", "openedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_filledOnBehalfById_fkey" FOREIGN KEY ("organizationId", "filledOnBehalfById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_submittedByContactId_fkey" FOREIGN KEY ("organizationId", "submittedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_supersededById_fkey" FOREIGN KEY ("organizationId", "supersededById") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAssessment" ADD CONSTRAINT "RiskAssessment_organizationId_workflowVersionId_fkey" FOREIGN KEY ("organizationId", "workflowVersionId") REFERENCES "WorkflowVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAnswer" ADD CONSTRAINT "RiskAnswer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAnswer" ADD CONSTRAINT "RiskAnswer_organizationId_assessmentId_fkey" FOREIGN KEY ("organizationId", "assessmentId") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAnswer" ADD CONSTRAINT "RiskAnswer_organizationId_evidenceDocumentId_fkey" FOREIGN KEY ("organizationId", "evidenceDocumentId") REFERENCES "SupplierDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAnswer" ADD CONSTRAINT "RiskAnswer_organizationId_answeredByContactId_fkey" FOREIGN KEY ("organizationId", "answeredByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAnswer" ADD CONSTRAINT "RiskAnswer_organizationId_answeredByMemberId_fkey" FOREIGN KEY ("organizationId", "answeredByMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskAnswer" ADD CONSTRAINT "RiskAnswer_organizationId_agentActionId_fkey" FOREIGN KEY ("organizationId", "agentActionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_organizationId_assessmentId_fkey" FOREIGN KEY ("organizationId", "assessmentId") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_organizationId_workflowVersionId_fkey" FOREIGN KEY ("organizationId", "workflowVersionId") REFERENCES "WorkflowVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_organizationId_assigneeMemberId_fkey" FOREIGN KEY ("organizationId", "assigneeMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_organizationId_delegatorMemberId_fkey" FOREIGN KEY ("organizationId", "delegatorMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReviewTask" ADD CONSTRAINT "ReviewTask_organizationId_decidedById_fkey" FOREIGN KEY ("organizationId", "decidedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskOverride" ADD CONSTRAINT "RiskOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskOverride" ADD CONSTRAINT "RiskOverride_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskOverride" ADD CONSTRAINT "RiskOverride_organizationId_assessmentId_fkey" FOREIGN KEY ("organizationId", "assessmentId") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskOverride" ADD CONSTRAINT "RiskOverride_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskOverride" ADD CONSTRAINT "RiskOverride_organizationId_requestedById_fkey" FOREIGN KEY ("organizationId", "requestedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskOverride" ADD CONSTRAINT "RiskOverride_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskReview" ADD CONSTRAINT "RiskReview_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskReview" ADD CONSTRAINT "RiskReview_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskReview" ADD CONSTRAINT "RiskReview_organizationId_completedByAssessmentId_fkey" FOREIGN KEY ("organizationId", "completedByAssessmentId") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskReview" ADD CONSTRAINT "RiskReview_organizationId_sourceAssessmentId_fkey" FOREIGN KEY ("organizationId", "sourceAssessmentId") REFERENCES "RiskAssessment"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RiskReview" ADD CONSTRAINT "RiskReview_organizationId_sourceOverrideId_fkey" FOREIGN KEY ("organizationId", "sourceOverrideId") REFERENCES "RiskOverride"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.1 and §6.3 for S11 (docs/sub-specs/S11.md "Entity และ migration"; added after the generated part) =====
-- The partial uniques (one open assessment and one COMPLETED per supplier, one open override per supplier, one open
-- review per reason per supplier) are in schema.prisma above; these are the CHECKs and the trigger risk_answer_frozen

-- Tier thresholds: LOW starts at 0; a change waits in pending* until someone other than its proposer confirms it
-- (BR-RSK-02 · ADR-229); the order LOW < MEDIUM < HIGH of the three rows is checked by the service
ALTER TABLE "RiskTier" ADD CONSTRAINT risk_tier_shape CHECK (
  "minPoints" >= 0
  AND ("code" <> 'LOW' OR "minPoints" = 0)
  AND "reviewMonths" BETWEEN 1 AND 120
  AND "reminderDaysBefore" >= 0
  AND ("confirmedById" IS NULL OR "confirmedById" <> "updatedById")
  AND (("confirmedById" IS NULL) = ("confirmedAt" IS NULL))
  AND (("pendingChange" IS NULL) = ("pendingById" IS NULL))
  AND (("pendingById" IS NULL) = ("pendingAt" IS NULL))
  AND "version" >= 0);

-- The gate policy, one row per organization, with the same light 4-eyes (BR-RSK-02 · BR-RSK-03)
ALTER TABLE "RiskPolicy" ADD CONSTRAINT risk_policy_shape CHECK (
  jsonb_typeof("screeningTierMap") = 'object'
  AND ("confirmedById" IS NULL OR "confirmedById" <> "updatedById")
  AND (("confirmedById" IS NULL) = ("confirmedAt" IS NULL))
  AND (("pendingChange" IS NULL) = ("pendingById" IS NULL))
  AND (("pendingById" IS NULL) = ("pendingAt" IS NULL))
  AND "version" >= 0);

-- A version is published by someone other than who submitted it (BR-RSK-02); a published or superseded version keeps both
ALTER TABLE "RiskQuestionnaire" ADD CONSTRAINT risk_questionnaire_shape CHECK (
  "versionNo" >= 1
  AND length("code") > 0
  AND ("status" NOT IN ('PUBLISHED', 'SUPERSEDED')
       OR ("publishedById" IS NOT NULL AND "submittedById" IS NOT NULL AND "publishedById" <> "submittedById" AND "publishedAt" IS NOT NULL))
  AND ("status" = 'DRAFT' OR ("submittedById" IS NOT NULL AND "submittedAt" IS NOT NULL))
  AND ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom")
  AND "version" >= 0);

-- A question: the code format of S7's linkedRiskQuestionCodes, at least two options, a scope when one is required (BR-RSK-05)
ALTER TABLE "RiskQuestion" ADD CONSTRAINT risk_question_shape CHECK (
  "code" ~ '^RQ-[A-Z]{2,4}-[0-9]{2}$'
  AND jsonb_typeof("options") = 'array' AND jsonb_array_length("options") >= 2
  AND ("appliesWhen" IS NULL OR jsonb_typeof("appliesWhen") = 'object')
  AND (NOT "evidenceScopeRequired" OR ("evidenceScope" IS NOT NULL AND length(btrim("evidenceScope")) > 0)));

-- An assessment: COMPLETED and SUPERSEDED, and only they, carry completedAt, tier and validUntil (INV-RSK-03); a submitted
-- one has its frozen tier and points (BR-RSK-04)
ALTER TABLE "RiskAssessment" ADD CONSTRAINT risk_assessment_shape CHECK (
  (("status" IN ('COMPLETED', 'SUPERSEDED')) = ("completedAt" IS NOT NULL AND "tier" IS NOT NULL AND "validUntil" IS NOT NULL))
  AND ("status" NOT IN ('IN_REVIEW', 'COMPLETED', 'SUPERSEDED') OR ("tier" IS NOT NULL AND "pointsTotal" IS NOT NULL AND "submittedAt" IS NOT NULL))
  AND (("completedAt" IS NULL) = ("completedOn" IS NULL))
  AND ("status" <> 'SUPERSEDED' OR "supersededById" IS NOT NULL)
  AND ("pointsTotal" IS NULL OR "pointsTotal" >= 0)
  AND jsonb_typeof("screening") = 'object'
  AND "reviewRound" >= 0
  AND "version" >= 0);

-- An answer from evidence names the document; one the supplier or procurement gave names who (BR-RSK-05 · BR-RSK-06)
ALTER TABLE "RiskAnswer" ADD CONSTRAINT risk_answer_shape CHECK (
  ("source" <> 'EVIDENCE' OR "evidenceDocumentId" IS NOT NULL)
  AND ("source" NOT IN ('EXPLICIT', 'ON_BEHALF') OR "answeredByContactId" IS NOT NULL OR "answeredByMemberId" IS NOT NULL)
  AND "points" >= 0
  AND ("note" IS NULL OR length("note") <= 500));

-- A decided task names when and who; a returned one has its reason (INV-RSK-04 · BR-RSK-07)
ALTER TABLE "ReviewTask" ADD CONSTRAINT review_task_shape CHECK (
  (("status" IN ('PASSED', 'RETURNED')) = ("decidedAt" IS NOT NULL AND "decidedById" IS NOT NULL))
  AND ("status" <> 'RETURNED' OR "reasonCommentId" IS NOT NULL)
  AND (("status" = 'CANCELLED') = ("cancelledWhy" IS NOT NULL))
  AND "reviewRound" >= 1 AND "groupNo" >= 1 AND "slotNo" >= 1
  AND cardinality("ruleCodes") >= 1 AND cardinality("riskDomains") >= 1
  AND "dueAt" >= "assignedAt"
  AND "version" >= 0);

-- An override: a positive cap (BR-DOA-21), a cumulative use within it, valid at least on the day it was sent (BR-RSK-10)
ALTER TABLE "RiskOverride" ADD CONSTRAINT risk_override_shape CHECK (
  "capGrossSatang" > 0
  AND "usedGrossSatang" BETWEEN 0 AND "capGrossSatang"
  AND "usedCount" >= 0
  AND ("submittedAt" IS NULL OR "expiresOn" >= ("submittedAt" AT TIME ZONE 'Asia/Bangkok')::date)
  AND ("status" IN ('DRAFT', 'CANCELLED') OR "submittedAt" IS NOT NULL)
  AND ("status" NOT IN ('APPROVED', 'REJECTED', 'EXPIRED') OR "decidedAt" IS NOT NULL)
  AND length("reason") BETWEEN 1 AND 2000
  AND "version" >= 0);

-- A review is DONE exactly when an assessment completed it; a STATUS_CHANGED review names its registry flag (BR-RSK-12)
ALTER TABLE "RiskReview" ADD CONSTRAINT risk_review_shape CHECK (
  (("status" = 'DONE') = ("completedAt" IS NOT NULL AND "completedByAssessmentId" IS NOT NULL))
  AND ("reason" <> 'STATUS_CHANGED' OR "registryFlag" IS NOT NULL)
  AND ("reason" <> 'OVERRIDE_EXPIRED' OR "sourceOverrideId" IS NOT NULL));

-- A risk rule of a workflow names the parts its reviewers see; a request rule names none (BR-RSK-07 · BR-RSK-08)
ALTER TABLE "WorkflowRule" ADD CONSTRAINT workflow_rule_risk_scope CHECK (
  ("scope" = 'RISK_ASSESSMENT') = (cardinality("riskDomains") > 0));

-- The answers of a COMPLETED or SUPERSEDED assessment are frozen (INV-RSK-03): no UPDATE, no DELETE, no new answer
CREATE FUNCTION risk_answer_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  frozen boolean;
BEGIN
  SELECT a."status" IN ('COMPLETED', 'SUPERSEDED') INTO frozen
    FROM "RiskAssessment" a
   WHERE a."organizationId" = COALESCE(OLD."organizationId", NEW."organizationId")
     AND a."id" = COALESCE(OLD."assessmentId", NEW."assessmentId");
  IF frozen THEN
    RAISE EXCEPTION 'risk_answer_frozen: the answers of a completed risk assessment cannot change (INV-RSK-03)'
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER risk_answer_frozen BEFORE INSERT OR UPDATE OR DELETE ON "RiskAnswer"
  FOR EACH ROW EXECUTE FUNCTION risk_answer_frozen();
