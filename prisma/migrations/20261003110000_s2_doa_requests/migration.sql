-- CreateEnum
CREATE TYPE "DepartmentKind" AS ENUM ('COMPANY', 'DIVISION', 'DEPARTMENT', 'SECTION');

-- CreateEnum
CREATE TYPE "PositionScope" AS ENUM ('DEPARTMENT', 'ORG');

-- CreateEnum
CREATE TYPE "DelegationStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'ENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DelegationCreatedVia" AS ENUM ('SELF', 'ORG_AUTHORITY_CHANGE');

-- CreateEnum
CREATE TYPE "RequestDocumentType" AS ENUM ('PURCHASE_REQUEST', 'SUPPLIER_REQUEST');

-- CreateEnum
CREATE TYPE "FormVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED', 'SUBMITTED', 'DONE');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('NORMAL', 'URGENT');

-- CreateEnum
CREATE TYPE "DoaVersionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AmountBasis" AS ENUM ('GROSS', 'NET');

-- CreateEnum
CREATE TYPE "SelfApprovalPolicy" AS ENUM ('ESCALATE_NEXT_BAND', 'BLOCK');

-- CreateEnum
CREATE TYPE "DoaDocumentType" AS ENUM ('PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE');

-- CreateEnum
CREATE TYPE "ApprovalSubjectType" AS ENUM ('REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE');

-- CreateEnum
CREATE TYPE "ApprovalRouteStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalStepMode" AS ENUM ('SEQUENTIAL', 'PARALLEL');

-- CreateEnum
CREATE TYPE "ApprovalQuorum" AS ENUM ('ALL', 'ANY', 'COUNT');

-- CreateEnum
CREATE TYPE "ApprovalStepStatus" AS ENUM ('WAITING', 'ACTIVE', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalTaskStatus" AS ENUM ('OPEN', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVE', 'REJECT', 'RETURN');

-- CreateEnum
CREATE TYPE "OrgAuthorityChangeKind" AS ENUM ('POSITION_ASSIGN', 'POSITION_END', 'DEPARTMENT_REPARENT', 'DELEGATION_ON_BEHALF', 'IDENTITY_RESET');

-- CreateEnum
CREATE TYPE "OrgAuthorityChangeStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'APPLIED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "parentId" UUID,
    "kind" "DepartmentKind" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostCenter" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "departmentId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CostCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "scope" "PositionScope" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionAssignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "validFrom" TIMESTAMPTZ(6) NOT NULL,
    "validTo" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PositionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delegation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "delegatorMemberId" UUID NOT NULL,
    "delegateMemberId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "documentTypes" "DoaDocumentType"[],
    "maxAmountSatang" BIGINT,
    "reason" TEXT NOT NULL,
    "status" "DelegationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdVia" "DelegationCreatedVia" NOT NULL,
    "orgAuthorityChangeId" UUID,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Delegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "nameTh" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "descriptionTh" TEXT,
    "icon" TEXT,
    "documentType" "RequestDocumentType" NOT NULL,
    "currentFormVersionId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RequestType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestTypeId" UUID NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "status" "FormVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMPTZ(6),
    "publishedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FormVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "requestTypeId" UUID NOT NULL,
    "formVersionId" UUID NOT NULL,
    "documentType" "RequestDocumentType" NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "requesterMemberId" UUID NOT NULL,
    "requesterDepartmentId" UUID NOT NULL,
    "chargedDepartmentId" UUID NOT NULL,
    "costCenterId" UUID,
    "urgency" "Urgency" NOT NULL DEFAULT 'NORMAL',
    "neededBy" DATE,
    "nonLowestQuoteReason" TEXT,
    "priceIncludesVat" BOOLEAN NOT NULL DEFAULT false,
    "netSatang" BIGINT NOT NULL DEFAULT 0,
    "vatSatang" BIGINT NOT NULL DEFAULT 0,
    "grossSatang" BIGINT NOT NULL DEFAULT 0,
    "vatRateBp" INTEGER,
    "taxPointDate" DATE,
    "formData" JSONB NOT NULL DEFAULT '{}',
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" TEXT,
    "currentRouteId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "categoryCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unitPriceSatang" BIGINT NOT NULL,
    "netSatang" BIGINT NOT NULL,
    "vatable" BOOLEAN NOT NULL DEFAULT true,
    "orderedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cancelledQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "serviceEndDate" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestQuotation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "supplierName" TEXT NOT NULL,
    "amountSatang" BIGINT NOT NULL,
    "includesVat" BOOLEAN NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "netSatang" BIGINT NOT NULL,
    "fileId" UUID,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RequestQuotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestFollower" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RequestFollower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InfoRequest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "askedById" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answeredById" UUID,
    "answer" TEXT,
    "askedAt" TIMESTAMPTZ(6) NOT NULL,
    "answeredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InfoRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoaVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "versionNo" INTEGER NOT NULL,
    "status" "DoaVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(6),
    "amountBasis" "AmountBasis" NOT NULL,
    "selfApprovalPolicy" "SelfApprovalPolicy" NOT NULL,
    "collapseDuplicateApprovers" BOOLEAN NOT NULL DEFAULT true,
    "stepUpThresholdSatang" BIGINT,
    "escalationPolicy" JSONB NOT NULL DEFAULT '{}',
    "sodPolicy" JSONB NOT NULL,
    "changeReason" TEXT,
    "diffSummary" JSONB,
    "sourceYaml" TEXT,
    "checksum" TEXT,
    "submittedById" UUID,
    "approvedById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "publishedAt" TIMESTAMPTZ(6),
    "withdrawnAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DoaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoaRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "doaVersionId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "documentType" "DoaDocumentType" NOT NULL,
    "priority" INTEGER NOT NULL,
    "when" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "descriptionTh" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DoaRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoaTestCase" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "doaVersionId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DoaTestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalRoute" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subjectType" "ApprovalSubjectType" NOT NULL,
    "subjectId" UUID NOT NULL,
    "routeNo" INTEGER NOT NULL,
    "doaVersionId" UUID NOT NULL,
    "ruleCode" TEXT NOT NULL,
    "escalatedFromRuleCode" TEXT,
    "amountBasis" "AmountBasis" NOT NULL,
    "amountSatang" BIGINT,
    "explanationTh" TEXT NOT NULL,
    "status" "ApprovalRouteStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApprovalRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "routeId" UUID NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "mode" "ApprovalStepMode" NOT NULL DEFAULT 'SEQUENTIAL',
    "quorum" "ApprovalQuorum" NOT NULL DEFAULT 'ALL',
    "quorumCount" INTEGER,
    "slaBusinessMinutes" INTEGER NOT NULL,
    "status" "ApprovalStepStatus" NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalTask" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "assigneeMemberId" UUID NOT NULL,
    "principalMemberId" UUID,
    "resolvedFrom" TEXT NOT NULL,
    "status" "ApprovalTaskStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAt" TIMESTAMPTZ(6) NOT NULL,
    "dueAt" TIMESTAMPTZ(6),
    "remindAt" TIMESTAMPTZ(6),
    "escalateAt" TIMESTAMPTZ(6),
    "remainingBusinessMinutes" INTEGER,
    "overdueAt" TIMESTAMPTZ(6),
    "escalatedAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "decidedByMemberId" UUID,
    "decision" "ApprovalDecision",
    "reason" TEXT,
    "channel" "Channel",
    "reassignedFromTaskId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ApprovalTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgAuthorityChange" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "OrgAuthorityChangeKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "submittedById" UUID NOT NULL,
    "routeId" UUID,
    "status" "OrgAuthorityChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "impactSummary" JSONB,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "appliedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrgAuthorityChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "documentType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "sourceUrl" TEXT,
    "note" TEXT,
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_organizationId_parentId_idx" ON "Department"("organizationId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_id_key" ON "Department"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_code_key" ON "Department"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "department_single_root" ON "Department"("organizationId") WHERE ("parentId" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_organizationId_id_key" ON "CostCenter"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CostCenter_organizationId_code_key" ON "CostCenter"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Position_organizationId_id_key" ON "Position"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Position_organizationId_code_key" ON "Position"("organizationId", "code");

-- CreateIndex
CREATE INDEX "PositionAssignment_organizationId_memberId_idx" ON "PositionAssignment"("organizationId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "position_single_holder" ON "PositionAssignment"("positionId", "departmentId") WHERE ("validTo" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "PositionAssignment_organizationId_id_key" ON "PositionAssignment"("organizationId", "id");

-- CreateIndex
CREATE INDEX "Delegation_organizationId_delegatorMemberId_idx" ON "Delegation"("organizationId", "delegatorMemberId");

-- CreateIndex
CREATE INDEX "Delegation_organizationId_delegateMemberId_idx" ON "Delegation"("organizationId", "delegateMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Delegation_organizationId_id_key" ON "Delegation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_organizationId_date_key" ON "Holiday"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RequestType_organizationId_id_key" ON "RequestType"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RequestType_organizationId_code_key" ON "RequestType"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_organizationId_id_key" ON "FormVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FormVersion_organizationId_requestTypeId_versionNo_key" ON "FormVersion"("organizationId", "requestTypeId", "versionNo");

-- CreateIndex
CREATE INDEX "Request_organizationId_status_idx" ON "Request"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Request_organizationId_requesterMemberId_idx" ON "Request"("organizationId", "requesterMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Request_organizationId_id_key" ON "Request"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Request_organizationId_number_key" ON "Request"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "RequestLine_organizationId_id_key" ON "RequestLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RequestLine_organizationId_requestId_lineNo_key" ON "RequestLine"("organizationId", "requestId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "request_quotation_one_selected" ON "RequestQuotation"("organizationId", "requestId") WHERE ("isSelected");

-- CreateIndex
CREATE UNIQUE INDEX "RequestQuotation_organizationId_id_key" ON "RequestQuotation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RequestFollower_organizationId_requestId_memberId_key" ON "RequestFollower"("organizationId", "requestId", "memberId");

-- CreateIndex
CREATE INDEX "InfoRequest_organizationId_requestId_idx" ON "InfoRequest"("organizationId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "InfoRequest_organizationId_id_key" ON "InfoRequest"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DoaVersion_organizationId_id_key" ON "DoaVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DoaVersion_organizationId_code_versionNo_key" ON "DoaVersion"("organizationId", "code", "versionNo");

-- CreateIndex
CREATE UNIQUE INDEX "DoaRule_organizationId_id_key" ON "DoaRule"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DoaRule_organizationId_doaVersionId_code_key" ON "DoaRule"("organizationId", "doaVersionId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DoaTestCase_organizationId_id_key" ON "DoaTestCase"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRoute_organizationId_id_key" ON "ApprovalRoute"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalRoute_organizationId_subjectType_subjectId_routeNo_key" ON "ApprovalRoute"("organizationId", "subjectType", "subjectId", "routeNo");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_organizationId_id_key" ON "ApprovalStep"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_organizationId_routeId_stepNo_key" ON "ApprovalStep"("organizationId", "routeId", "stepNo");

-- CreateIndex
CREATE INDEX "ApprovalTask_organizationId_assigneeMemberId_status_idx" ON "ApprovalTask"("organizationId", "assigneeMemberId", "status");

-- CreateIndex
CREATE INDEX "ApprovalTask_organizationId_principalMemberId_status_idx" ON "ApprovalTask"("organizationId", "principalMemberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalTask_organizationId_id_key" ON "ApprovalTask"("organizationId", "id");

-- CreateIndex
CREATE INDEX "OrgAuthorityChange_organizationId_status_idx" ON "OrgAuthorityChange"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrgAuthorityChange_organizationId_id_key" ON "OrgAuthorityChange"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSequence_organizationId_documentType_scopeKey_key" ON "DocumentSequence"("organizationId", "documentType", "scopeKey");

-- CreateIndex
CREATE INDEX "TaxRate_code_effectiveFrom_idx" ON "TaxRate"("code", "effectiveFrom");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_organizationId_primaryDepartmentId_fkey" FOREIGN KEY ("organizationId", "primaryDepartmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationId_scopeDepartmentId_fkey" FOREIGN KEY ("organizationId", "scopeDepartmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_parentId_fkey" FOREIGN KEY ("organizationId", "parentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CostCenter" ADD CONSTRAINT "CostCenter_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PositionAssignment" ADD CONSTRAINT "PositionAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PositionAssignment" ADD CONSTRAINT "PositionAssignment_organizationId_positionId_fkey" FOREIGN KEY ("organizationId", "positionId") REFERENCES "Position"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PositionAssignment" ADD CONSTRAINT "PositionAssignment_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PositionAssignment" ADD CONSTRAINT "PositionAssignment_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_organizationId_delegatorMemberId_fkey" FOREIGN KEY ("organizationId", "delegatorMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_organizationId_delegateMemberId_fkey" FOREIGN KEY ("organizationId", "delegateMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Delegation" ADD CONSTRAINT "Delegation_organizationId_orgAuthorityChangeId_fkey" FOREIGN KEY ("organizationId", "orgAuthorityChangeId") REFERENCES "OrgAuthorityChange"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Holiday" ADD CONSTRAINT "Holiday_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestType" ADD CONSTRAINT "RequestType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestType" ADD CONSTRAINT "RequestType_organizationId_currentFormVersionId_fkey" FOREIGN KEY ("organizationId", "currentFormVersionId") REFERENCES "FormVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_organizationId_requestTypeId_fkey" FOREIGN KEY ("organizationId", "requestTypeId") REFERENCES "RequestType"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FormVersion" ADD CONSTRAINT "FormVersion_organizationId_publishedById_fkey" FOREIGN KEY ("organizationId", "publishedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_requestTypeId_fkey" FOREIGN KEY ("organizationId", "requestTypeId") REFERENCES "RequestType"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_formVersionId_fkey" FOREIGN KEY ("organizationId", "formVersionId") REFERENCES "FormVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_requesterMemberId_fkey" FOREIGN KEY ("organizationId", "requesterMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_requesterDepartmentId_fkey" FOREIGN KEY ("organizationId", "requesterDepartmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_chargedDepartmentId_fkey" FOREIGN KEY ("organizationId", "chargedDepartmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_costCenterId_fkey" FOREIGN KEY ("organizationId", "costCenterId") REFERENCES "CostCenter"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestQuotation" ADD CONSTRAINT "RequestQuotation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestQuotation" ADD CONSTRAINT "RequestQuotation_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestQuotation" ADD CONSTRAINT "RequestQuotation_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestFollower" ADD CONSTRAINT "RequestFollower_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestFollower" ADD CONSTRAINT "RequestFollower_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestFollower" ADD CONSTRAINT "RequestFollower_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InfoRequest" ADD CONSTRAINT "InfoRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InfoRequest" ADD CONSTRAINT "InfoRequest_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InfoRequest" ADD CONSTRAINT "InfoRequest_organizationId_taskId_fkey" FOREIGN KEY ("organizationId", "taskId") REFERENCES "ApprovalTask"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InfoRequest" ADD CONSTRAINT "InfoRequest_organizationId_askedById_fkey" FOREIGN KEY ("organizationId", "askedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InfoRequest" ADD CONSTRAINT "InfoRequest_organizationId_answeredById_fkey" FOREIGN KEY ("organizationId", "answeredById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaVersion" ADD CONSTRAINT "DoaVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaVersion" ADD CONSTRAINT "DoaVersion_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaVersion" ADD CONSTRAINT "DoaVersion_organizationId_approvedById_fkey" FOREIGN KEY ("organizationId", "approvedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaRule" ADD CONSTRAINT "DoaRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaRule" ADD CONSTRAINT "DoaRule_organizationId_doaVersionId_fkey" FOREIGN KEY ("organizationId", "doaVersionId") REFERENCES "DoaVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaTestCase" ADD CONSTRAINT "DoaTestCase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DoaTestCase" ADD CONSTRAINT "DoaTestCase_organizationId_doaVersionId_fkey" FOREIGN KEY ("organizationId", "doaVersionId") REFERENCES "DoaVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRoute" ADD CONSTRAINT "ApprovalRoute_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalRoute" ADD CONSTRAINT "ApprovalRoute_organizationId_doaVersionId_fkey" FOREIGN KEY ("organizationId", "doaVersionId") REFERENCES "DoaVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_organizationId_routeId_fkey" FOREIGN KEY ("organizationId", "routeId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_organizationId_stepId_fkey" FOREIGN KEY ("organizationId", "stepId") REFERENCES "ApprovalStep"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_organizationId_assigneeMemberId_fkey" FOREIGN KEY ("organizationId", "assigneeMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_organizationId_principalMemberId_fkey" FOREIGN KEY ("organizationId", "principalMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_organizationId_decidedByMemberId_fkey" FOREIGN KEY ("organizationId", "decidedByMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ApprovalTask" ADD CONSTRAINT "ApprovalTask_organizationId_reassignedFromTaskId_fkey" FOREIGN KEY ("organizationId", "reassignedFromTaskId") REFERENCES "ApprovalTask"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrgAuthorityChange" ADD CONSTRAINT "OrgAuthorityChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrgAuthorityChange" ADD CONSTRAINT "OrgAuthorityChange_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrgAuthorityChange" ADD CONSTRAINT "OrgAuthorityChange_organizationId_routeId_fkey" FOREIGN KEY ("organizationId", "routeId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DocumentSequence" ADD CONSTRAINT "DocumentSequence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===== spec §6.3 items 3-5 and the S2 constraints (added after the generated part) =====

-- §6.3 (5): DOA versions in effect never overlap for one DOA code
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "DoaVersion" ADD CONSTRAINT doa_no_overlap EXCLUDE USING gist (
  "organizationId" WITH =,
  "code" WITH =,
  tstzrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamptz)) WITH &&
) WHERE ("status" IN ('PUBLISHED', 'SUPERSEDED'));
ALTER TABLE "DoaVersion" ADD CONSTRAINT doa_version_period CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- BR-DLG-03: [startsAt, endsAt), not to oneself, and one delegator's live periods never overlap
ALTER TABLE "Delegation" ADD CONSTRAINT delegation_period CHECK ("startsAt" < "endsAt");
ALTER TABLE "Delegation" ADD CONSTRAINT delegation_not_self CHECK ("delegatorMemberId" <> "delegateMemberId");
ALTER TABLE "Delegation" ADD CONSTRAINT delegation_no_overlap EXCLUDE USING gist (
  "organizationId" WITH =,
  "delegatorMemberId" WITH =,
  tstzrange("startsAt", "endsAt") WITH &&
) WHERE ("status" IN ('SCHEDULED', 'ACTIVE'));

-- BR-VAT-01: VAT periods of one code never overlap (effectiveTo is the last day, inclusive; null = open-ended)
ALTER TABLE "TaxRate" ADD CONSTRAINT tax_rate_values CHECK ("rateBp" >= 0 AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"));
ALTER TABLE "TaxRate" ADD CONSTRAINT tax_rate_no_overlap EXCLUDE USING gist (
  "code" WITH =,
  daterange("effectiveFrom", "effectiveTo", '[]') WITH &&
);

-- Department tree (§6.2): one root per organization (partial unique index in the schema), never its own ancestor
ALTER TABLE "Department" ADD CONSTRAINT department_not_own_parent CHECK ("parentId" IS NULL OR "parentId" <> "id");
CREATE OR REPLACE FUNCTION bcs_department_no_cycle() RETURNS trigger AS $$
DECLARE
  ancestor uuid := NEW."parentId";
  steps integer := 0;
BEGIN
  WHILE ancestor IS NOT NULL LOOP
    IF ancestor = NEW."id" THEN
      RAISE EXCEPTION 'department % would become its own ancestor', NEW."code" USING ERRCODE = 'check_violation';
    END IF;
    SELECT "parentId" INTO ancestor FROM "Department" WHERE "id" = ancestor AND "organizationId" = NEW."organizationId";
    steps := steps + 1;
    IF steps > 1000 THEN
      RAISE EXCEPTION 'department tree deeper than 1000 levels' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "Department_no_cycle" BEFORE INSERT OR UPDATE OF "parentId" ON "Department"
  FOR EACH ROW EXECUTE FUNCTION bcs_department_no_cycle();

-- PositionAssignment period
ALTER TABLE "PositionAssignment" ADD CONSTRAINT position_assignment_period CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

-- §6.3 (3): request line quantities
ALTER TABLE "RequestLine" ADD CONSTRAINT request_line_qty CHECK ("orderedQuantity" + "cancelledQuantity" <= "quantity");
ALTER TABLE "RequestLine" ADD CONSTRAINT request_line_qty_values CHECK ("quantity" > 0 AND "orderedQuantity" >= 0 AND "cancelledQuantity" >= 0);

-- Money never below zero (ADR-018)
ALTER TABLE "Request" ADD CONSTRAINT request_money_non_negative CHECK ("netSatang" >= 0 AND "vatSatang" >= 0 AND "grossSatang" >= 0);
ALTER TABLE "RequestLine" ADD CONSTRAINT request_line_money_non_negative CHECK ("unitPriceSatang" >= 0 AND "netSatang" >= 0);
ALTER TABLE "RequestQuotation" ADD CONSTRAINT request_quotation_money_non_negative CHECK ("amountSatang" >= 0 AND "netSatang" >= 0);
ALTER TABLE "DoaVersion" ADD CONSTRAINT doa_version_money_non_negative CHECK ("stepUpThresholdSatang" IS NULL OR "stepUpThresholdSatang" >= 0);
ALTER TABLE "ApprovalRoute" ADD CONSTRAINT approval_route_money_non_negative CHECK ("amountSatang" IS NULL OR "amountSatang" >= 0);
ALTER TABLE "Delegation" ADD CONSTRAINT delegation_money_positive CHECK ("maxAmountSatang" IS NULL OR "maxAmountSatang" > 0);

-- Numbering (INV-NUM-01)
ALTER TABLE "DocumentSequence" ADD CONSTRAINT document_sequence_next_positive CHECK ("nextValue" >= 1);
