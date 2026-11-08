-- CreateEnum
CREATE TYPE "RfxKind" AS ENUM ('RFQ', 'RFP', 'RFI');

-- CreateEnum
CREATE TYPE "RfxStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'EVALUATING', 'AWARDED', 'CONCLUDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RfxSourceKind" AS ENUM ('REQUEST_LINES', 'NEED');

-- CreateEnum
CREATE TYPE "RfxLocale" AS ENUM ('TH', 'TH_EN');

-- CreateEnum
CREATE TYPE "RfxRefSource" AS ENUM ('AGREEMENT', 'CATALOG', 'HISTORY', 'MANUAL');

-- CreateEnum
CREATE TYPE "RfxInviteStatus" AS ENUM ('INVITED', 'VIEWED', 'DECLINED', 'BID_SUBMITTED', 'WITHDRAWN', 'EXPIRED', 'REMOVED');

-- CreateEnum
CREATE TYPE "RfxQuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "RfxQuestionVisibility" AS ENUM ('ALL', 'ASKER');

-- CreateEnum
CREATE TYPE "BidStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'WITHDRAWN', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "ScorecardStatus" AS ENUM ('DRAFT', 'LOCKED', 'REVEALED');

-- CreateEnum
CREATE TYPE "ScorecardEvaluatorStatus" AS ENUM ('ASSIGNED', 'SUBMITTED', 'RECUSED');

-- CreateEnum
CREATE TYPE "ScoreCriterionKind" AS ENUM ('PRICE', 'QUALITY');

-- CreateEnum
CREATE TYPE "AwardDecisionStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AwardPoStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING_PRICE', 'CREATED');

-- CreateEnum
CREATE TYPE "PreferredSupplierSource" AS ENUM ('SOURCING', 'MANUAL');

-- AlterEnum
ALTER TYPE "AiAgent" ADD VALUE 'SOURCING';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiPurpose" ADD VALUE 'RFX_DRAFT';
ALTER TYPE "AiPurpose" ADD VALUE 'BID_SUMMARY';
ALTER TYPE "AiPurpose" ADD VALUE 'NEGOTIATION_POINTS';

-- AlterEnum
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'AWARD_DECISION';

-- AlterEnum
ALTER TYPE "DoaDocumentType" ADD VALUE 'RFX_AWARD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FileLinkKind" ADD VALUE 'RFX_DOC';
ALTER TYPE "FileLinkKind" ADD VALUE 'BID_DOC';

-- AlterEnum
ALTER TYPE "PortalInviteLinkPurpose" ADD VALUE 'RFX_INVITE';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "awardDecisionId" UUID,
ADD COLUMN     "rfxEventId" UUID;

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "preferredSupplierOverrideReason" TEXT;

-- AlterTable
ALTER TABLE "RequestLine" ADD COLUMN     "rfxEventId" UUID;

-- CreateTable
CREATE TABLE "RfxEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "kind" "RfxKind" NOT NULL,
    "status" "RfxStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "titleEn" TEXT,
    "description" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "categoryCode" TEXT NOT NULL,
    "sourceKind" "RfxSourceKind" NOT NULL,
    "requestingDepartmentId" UUID NOT NULL,
    "sourceDepartmentIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "createdById" UUID NOT NULL,
    "openedById" UUID,
    "openedAt" TIMESTAMPTZ(6),
    "closesAt" TIMESTAMPTZ(6),
    "questionCutoffAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "revisionNo" INTEGER NOT NULL DEFAULT 1,
    "sealed" BOOLEAN NOT NULL DEFAULT true,
    "allowPartialBids" BOOLEAN NOT NULL DEFAULT false,
    "allowVatInclusiveBids" BOOLEAN NOT NULL DEFAULT false,
    "bidValidityDays" INTEGER NOT NULL DEFAULT 30,
    "minInvites" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "locale" "RfxLocale" NOT NULL DEFAULT 'TH',
    "scorecardId" UUID,
    "awardDecisionId" UUID,
    "conclusionNote" TEXT,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "estimatedNetSatang" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RfxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfxLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "categoryCode" TEXT NOT NULL,
    "catalogItemId" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "uomEn" TEXT,
    "deliverySiteId" UUID,
    "refUnitPriceSatang" BIGINT,
    "refSource" "RfxRefSource",
    "requiredDeliveryOn" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RfxLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfxLineSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxLineId" UUID NOT NULL,
    "requestLineId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RfxLineSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfxInvite" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "supplierId" UUID,
    "applicationId" UUID,
    "contactId" UUID NOT NULL,
    "status" "RfxInviteStatus" NOT NULL DEFAULT 'INVITED',
    "invitedById" UUID NOT NULL,
    "invitedAt" TIMESTAMPTZ(6) NOT NULL,
    "viewedAt" TIMESTAMPTZ(6),
    "declinedAt" TIMESTAMPTZ(6),
    "declineReason" TEXT,
    "removedAt" TIMESTAMPTZ(6),
    "removeReason" TEXT,
    "linkId" UUID,
    "needsReconfirm" BOOLEAN NOT NULL DEFAULT false,
    "supplierSnapshot" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RfxInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfxQuestion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "inviteId" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "askedByContactId" UUID NOT NULL,
    "askedAt" TIMESTAMPTZ(6) NOT NULL,
    "answer" TEXT,
    "answeredById" UUID,
    "answeredAt" TIMESTAMPTZ(6),
    "status" "RfxQuestionStatus" NOT NULL DEFAULT 'OPEN',
    "visibility" "RfxQuestionVisibility" NOT NULL DEFAULT 'ALL',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RfxQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RfxAmendment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "summaryEn" TEXT,
    "changedFields" JSONB NOT NULL DEFAULT '[]',
    "previousClosesAt" TIMESTAMPTZ(6),
    "newClosesAt" TIMESTAMPTZ(6),
    "createdById" UUID NOT NULL,
    "notifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RfxAmendment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "inviteId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "status" "BidStatus" NOT NULL DEFAULT 'DRAFT',
    "priceIncludesVat" BOOLEAN NOT NULL DEFAULT false,
    "isVatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "vatRateBp" INTEGER,
    "quotedTotalSatang" BIGINT NOT NULL DEFAULT 0,
    "netSatang" BIGINT NOT NULL DEFAULT 0,
    "vatSatang" BIGINT NOT NULL DEFAULT 0,
    "grossSatang" BIGINT NOT NULL DEFAULT 0,
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "validUntil" DATE,
    "deliveryDays" INTEGER,
    "promisedDeliveryOn" DATE,
    "note" TEXT,
    "submittedAt" TIMESTAMPTZ(6),
    "submittedByContactId" UUID,
    "submittedByMemberId" UUID,
    "submitCount" INTEGER NOT NULL DEFAULT 0,
    "revisionNoAtSubmit" INTEGER,
    "netPricesConfirmedAt" TIMESTAMPTZ(6),
    "withdrawnAt" TIMESTAMPTZ(6),
    "disqualifyReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BidLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "bidId" UUID NOT NULL,
    "rfxLineId" UUID NOT NULL,
    "offered" BOOLEAN NOT NULL DEFAULT true,
    "unitPriceSatang" BIGINT,
    "lineQuotedSatang" BIGINT,
    "lineNetSatang" BIGINT,
    "confirmedNetUnitPriceSatang" BIGINT,
    "brand" TEXT,
    "leadTimeDays" INTEGER,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BidLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scorecard" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "status" "ScorecardStatus" NOT NULL DEFAULT 'DRAFT',
    "lockedAt" TIMESTAMPTZ(6),
    "revealedAt" TIMESTAMPTZ(6),
    "minEvaluators" INTEGER NOT NULL DEFAULT 2,
    "priceCriterionCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Scorecard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScorecardEvaluator" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scorecardId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "status" "ScorecardEvaluatorStatus" NOT NULL DEFAULT 'ASSIGNED',
    "declaredInterest" BOOLEAN NOT NULL DEFAULT false,
    "recuseReason" TEXT,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ScorecardEvaluator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreCriterion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scorecardId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "weightBp" INTEGER NOT NULL,
    "kind" "ScoreCriterionKind" NOT NULL,
    "guidance" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ScoreCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scorecardId" UUID NOT NULL,
    "criterionId" UUID NOT NULL,
    "bidId" UUID NOT NULL,
    "evaluatorMemberId" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "submittedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ScoreEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwardDecision" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "rfxEventId" UUID NOT NULL,
    "number" TEXT,
    "status" "AwardDecisionStatus" NOT NULL DEFAULT 'DRAFT',
    "isSplit" BOOLEAN NOT NULL DEFAULT false,
    "netSatang" BIGINT NOT NULL,
    "vatSatang" BIGINT NOT NULL,
    "grossSatang" BIGINT NOT NULL,
    "amountBasis" "AmountBasis",
    "reason" TEXT,
    "topScoreBidId" UUID,
    "lowestBidId" UUID,
    "rankingSnapshot" JSONB,
    "sourceApprovedNetSatang" BIGINT,
    "reasonCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID NOT NULL,
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "currentRouteId" UUID,
    "poStatus" "AwardPoStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "purchaseOrderIds" JSONB NOT NULL DEFAULT '[]',
    "priceAgreementIds" JSONB NOT NULL DEFAULT '[]',
    "contractRef" TEXT,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AwardDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AwardLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "awardDecisionId" UUID NOT NULL,
    "rfxLineId" UUID NOT NULL,
    "bidId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPriceSatang" BIGINT NOT NULL,
    "lineNetSatang" BIGINT NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AwardLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreferredSupplier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "source" "PreferredSupplierSource" NOT NULL,
    "awardDecisionId" UUID,
    "note" TEXT,
    "createdById" UUID,
    "endedAt" TIMESTAMPTZ(6),
    "endedById" UUID,
    "endReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PreferredSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RfxEvent_organizationId_status_closesAt_idx" ON "RfxEvent"("organizationId", "status", "closesAt");

-- CreateIndex
CREATE INDEX "RfxEvent_organizationId_categoryCode_idx" ON "RfxEvent"("organizationId", "categoryCode");

-- CreateIndex
CREATE UNIQUE INDEX "RfxEvent_organizationId_id_key" ON "RfxEvent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RfxEvent_organizationId_number_key" ON "RfxEvent"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "RfxEvent_organizationId_scorecardId_key" ON "RfxEvent"("organizationId", "scorecardId");

-- CreateIndex
CREATE UNIQUE INDEX "RfxEvent_organizationId_awardDecisionId_key" ON "RfxEvent"("organizationId", "awardDecisionId");

-- CreateIndex
CREATE UNIQUE INDEX "RfxLine_organizationId_id_key" ON "RfxLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RfxLine_organizationId_rfxEventId_lineNo_key" ON "RfxLine"("organizationId", "rfxEventId", "lineNo");

-- CreateIndex
CREATE INDEX "RfxLineSource_organizationId_rfxLineId_idx" ON "RfxLineSource"("organizationId", "rfxLineId");

-- CreateIndex
CREATE UNIQUE INDEX "RfxLineSource_organizationId_id_key" ON "RfxLineSource"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfx_line_source_active_request_line" ON "RfxLineSource"("organizationId", "requestLineId") WHERE (active);

-- CreateIndex
CREATE INDEX "RfxInvite_organizationId_supplierId_idx" ON "RfxInvite"("organizationId", "supplierId");

-- CreateIndex
CREATE INDEX "RfxInvite_organizationId_rfxEventId_status_idx" ON "RfxInvite"("organizationId", "rfxEventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RfxInvite_organizationId_id_key" ON "RfxInvite"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rfx_invite_supplier" ON "RfxInvite"("organizationId", "rfxEventId", "supplierId") WHERE ("supplierId" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "rfx_invite_application" ON "RfxInvite"("organizationId", "rfxEventId", "applicationId") WHERE ("applicationId" IS NOT NULL);

-- CreateIndex
CREATE INDEX "RfxQuestion_organizationId_rfxEventId_askedAt_idx" ON "RfxQuestion"("organizationId", "rfxEventId", "askedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RfxQuestion_organizationId_id_key" ON "RfxQuestion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RfxAmendment_organizationId_id_key" ON "RfxAmendment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RfxAmendment_organizationId_rfxEventId_revisionNo_key" ON "RfxAmendment"("organizationId", "rfxEventId", "revisionNo");

-- CreateIndex
CREATE INDEX "Bid_organizationId_rfxEventId_status_idx" ON "Bid"("organizationId", "rfxEventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Bid_organizationId_id_key" ON "Bid"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Bid_organizationId_rfxEventId_supplierId_key" ON "Bid"("organizationId", "rfxEventId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "BidLine_organizationId_id_key" ON "BidLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BidLine_organizationId_bidId_rfxLineId_key" ON "BidLine"("organizationId", "bidId", "rfxLineId");

-- CreateIndex
CREATE UNIQUE INDEX "Scorecard_organizationId_id_key" ON "Scorecard"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Scorecard_organizationId_rfxEventId_key" ON "Scorecard"("organizationId", "rfxEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ScorecardEvaluator_organizationId_id_key" ON "ScorecardEvaluator"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ScorecardEvaluator_organizationId_scorecardId_memberId_key" ON "ScorecardEvaluator"("organizationId", "scorecardId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreCriterion_organizationId_id_key" ON "ScoreCriterion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreCriterion_organizationId_scorecardId_code_key" ON "ScoreCriterion"("organizationId", "scorecardId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "score_criterion_one_price" ON "ScoreCriterion"("organizationId", "scorecardId") WHERE (kind = 'PRICE'::"ScoreCriterionKind");

-- CreateIndex
CREATE INDEX "ScoreEntry_organizationId_scorecardId_evaluatorMemberId_idx" ON "ScoreEntry"("organizationId", "scorecardId", "evaluatorMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreEntry_organizationId_id_key" ON "ScoreEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreEntry_organizationId_criterionId_bidId_evaluatorMember_key" ON "ScoreEntry"("organizationId", "criterionId", "bidId", "evaluatorMemberId");

-- CreateIndex
CREATE INDEX "AwardDecision_organizationId_status_idx" ON "AwardDecision"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AwardDecision_organizationId_id_key" ON "AwardDecision"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AwardDecision_organizationId_number_key" ON "AwardDecision"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "award_decision_one_open" ON "AwardDecision"("organizationId", "rfxEventId") WHERE (status <> ALL (ARRAY['REJECTED'::"AwardDecisionStatus", 'CANCELLED'::"AwardDecisionStatus"]));

-- CreateIndex
CREATE UNIQUE INDEX "AwardLine_organizationId_id_key" ON "AwardLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AwardLine_organizationId_awardDecisionId_rfxLineId_key" ON "AwardLine"("organizationId", "awardDecisionId", "rfxLineId");

-- CreateIndex
CREATE INDEX "PreferredSupplier_organizationId_categoryCode_validTo_idx" ON "PreferredSupplier"("organizationId", "categoryCode", "validTo");

-- CreateIndex
CREATE INDEX "PreferredSupplier_organizationId_supplierId_idx" ON "PreferredSupplier"("organizationId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PreferredSupplier_organizationId_id_key" ON "PreferredSupplier"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_awardDecisionId_fkey" FOREIGN KEY ("organizationId", "awardDecisionId") REFERENCES "AwardDecision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxEvent" ADD CONSTRAINT "RfxEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxEvent" ADD CONSTRAINT "RfxEvent_organizationId_requestingDepartmentId_fkey" FOREIGN KEY ("organizationId", "requestingDepartmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxEvent" ADD CONSTRAINT "RfxEvent_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxEvent" ADD CONSTRAINT "RfxEvent_organizationId_openedById_fkey" FOREIGN KEY ("organizationId", "openedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxEvent" ADD CONSTRAINT "RfxEvent_organizationId_scorecardId_fkey" FOREIGN KEY ("organizationId", "scorecardId") REFERENCES "Scorecard"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxEvent" ADD CONSTRAINT "RfxEvent_organizationId_awardDecisionId_fkey" FOREIGN KEY ("organizationId", "awardDecisionId") REFERENCES "AwardDecision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLine" ADD CONSTRAINT "RfxLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLine" ADD CONSTRAINT "RfxLine_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLine" ADD CONSTRAINT "RfxLine_organizationId_catalogItemId_fkey" FOREIGN KEY ("organizationId", "catalogItemId") REFERENCES "CatalogItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLine" ADD CONSTRAINT "RfxLine_organizationId_deliverySiteId_fkey" FOREIGN KEY ("organizationId", "deliverySiteId") REFERENCES "DeliverySite"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLineSource" ADD CONSTRAINT "RfxLineSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLineSource" ADD CONSTRAINT "RfxLineSource_organizationId_rfxLineId_fkey" FOREIGN KEY ("organizationId", "rfxLineId") REFERENCES "RfxLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxLineSource" ADD CONSTRAINT "RfxLineSource_organizationId_requestLineId_fkey" FOREIGN KEY ("organizationId", "requestLineId") REFERENCES "RequestLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_applicationId_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "SupplierApplication"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_invitedById_fkey" FOREIGN KEY ("organizationId", "invitedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxInvite" ADD CONSTRAINT "RfxInvite_organizationId_linkId_fkey" FOREIGN KEY ("organizationId", "linkId") REFERENCES "PortalInviteLink"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxQuestion" ADD CONSTRAINT "RfxQuestion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxQuestion" ADD CONSTRAINT "RfxQuestion_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxQuestion" ADD CONSTRAINT "RfxQuestion_organizationId_inviteId_fkey" FOREIGN KEY ("organizationId", "inviteId") REFERENCES "RfxInvite"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxQuestion" ADD CONSTRAINT "RfxQuestion_organizationId_askedByContactId_fkey" FOREIGN KEY ("organizationId", "askedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxQuestion" ADD CONSTRAINT "RfxQuestion_organizationId_answeredById_fkey" FOREIGN KEY ("organizationId", "answeredById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxAmendment" ADD CONSTRAINT "RfxAmendment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxAmendment" ADD CONSTRAINT "RfxAmendment_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RfxAmendment" ADD CONSTRAINT "RfxAmendment_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_organizationId_inviteId_fkey" FOREIGN KEY ("organizationId", "inviteId") REFERENCES "RfxInvite"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_organizationId_submittedByContactId_fkey" FOREIGN KEY ("organizationId", "submittedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_organizationId_submittedByMemberId_fkey" FOREIGN KEY ("organizationId", "submittedByMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BidLine" ADD CONSTRAINT "BidLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BidLine" ADD CONSTRAINT "BidLine_organizationId_bidId_fkey" FOREIGN KEY ("organizationId", "bidId") REFERENCES "Bid"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BidLine" ADD CONSTRAINT "BidLine_organizationId_rfxLineId_fkey" FOREIGN KEY ("organizationId", "rfxLineId") REFERENCES "RfxLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Scorecard" ADD CONSTRAINT "Scorecard_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Scorecard" ADD CONSTRAINT "Scorecard_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScorecardEvaluator" ADD CONSTRAINT "ScorecardEvaluator_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScorecardEvaluator" ADD CONSTRAINT "ScorecardEvaluator_organizationId_scorecardId_fkey" FOREIGN KEY ("organizationId", "scorecardId") REFERENCES "Scorecard"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScorecardEvaluator" ADD CONSTRAINT "ScorecardEvaluator_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreCriterion" ADD CONSTRAINT "ScoreCriterion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreCriterion" ADD CONSTRAINT "ScoreCriterion_organizationId_scorecardId_fkey" FOREIGN KEY ("organizationId", "scorecardId") REFERENCES "Scorecard"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreEntry" ADD CONSTRAINT "ScoreEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreEntry" ADD CONSTRAINT "ScoreEntry_organizationId_scorecardId_fkey" FOREIGN KEY ("organizationId", "scorecardId") REFERENCES "Scorecard"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreEntry" ADD CONSTRAINT "ScoreEntry_organizationId_criterionId_fkey" FOREIGN KEY ("organizationId", "criterionId") REFERENCES "ScoreCriterion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreEntry" ADD CONSTRAINT "ScoreEntry_organizationId_bidId_fkey" FOREIGN KEY ("organizationId", "bidId") REFERENCES "Bid"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ScoreEntry" ADD CONSTRAINT "ScoreEntry_organizationId_evaluatorMemberId_fkey" FOREIGN KEY ("organizationId", "evaluatorMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_rfxEventId_fkey" FOREIGN KEY ("organizationId", "rfxEventId") REFERENCES "RfxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_topScoreBidId_fkey" FOREIGN KEY ("organizationId", "topScoreBidId") REFERENCES "Bid"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_lowestBidId_fkey" FOREIGN KEY ("organizationId", "lowestBidId") REFERENCES "Bid"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardDecision" ADD CONSTRAINT "AwardDecision_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardLine" ADD CONSTRAINT "AwardLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardLine" ADD CONSTRAINT "AwardLine_organizationId_awardDecisionId_fkey" FOREIGN KEY ("organizationId", "awardDecisionId") REFERENCES "AwardDecision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardLine" ADD CONSTRAINT "AwardLine_organizationId_rfxLineId_fkey" FOREIGN KEY ("organizationId", "rfxLineId") REFERENCES "RfxLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardLine" ADD CONSTRAINT "AwardLine_organizationId_bidId_fkey" FOREIGN KEY ("organizationId", "bidId") REFERENCES "Bid"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AwardLine" ADD CONSTRAINT "AwardLine_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PreferredSupplier" ADD CONSTRAINT "PreferredSupplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PreferredSupplier" ADD CONSTRAINT "PreferredSupplier_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PreferredSupplier" ADD CONSTRAINT "PreferredSupplier_organizationId_awardDecisionId_fkey" FOREIGN KEY ("organizationId", "awardDecisionId") REFERENCES "AwardDecision"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PreferredSupplier" ADD CONSTRAINT "PreferredSupplier_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PreferredSupplier" ADD CONSTRAINT "PreferredSupplier_organizationId_endedById_fkey" FOREIGN KEY ("organizationId", "endedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.1 and §6.3 for S10 (docs/sub-specs/S10.md "Entity และ migration"; added after the generated part) =====
-- The partial uniques (a request line in one open RFx, one invite per supplier or application per RFx, one PRICE
-- criterion per scorecard, one open award per RFx) are in schema.prisma above; these are the CHECKs and the trigger.
-- Money in satang is never negative (§6.1); rates and weights in basis points stay within 0..10000.

-- THB only (NG-9); an RFI has no scorecard; an RFx past DRAFT has its number and times, one that ended says how
ALTER TABLE "RfxEvent" ADD CONSTRAINT rfx_event_shape CHECK (
  "currency" = 'THB'
  AND ("kind" <> 'RFI' OR "scorecardId" IS NULL)
  AND ("closesAt" IS NULL OR "openedAt" IS NULL OR "closesAt" > "openedAt")
  AND ("questionCutoffAt" IS NULL OR "closesAt" IS NULL OR "questionCutoffAt" <= "closesAt")
  AND ("status" IN ('DRAFT', 'CANCELLED') OR ("number" IS NOT NULL AND "openedAt" IS NOT NULL AND "openedById" IS NOT NULL AND "closesAt" IS NOT NULL))
  AND ("status" IN ('DRAFT', 'OPEN', 'CANCELLED') OR "closedAt" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND "cancelledAt" IS NOT NULL))
  AND ("status" <> 'CONCLUDED' OR ("kind" = 'RFI' AND "conclusionNote" IS NOT NULL))
  AND ("status" <> 'AWARDED' OR ("kind" <> 'RFI' AND "awardDecisionId" IS NOT NULL))
  AND "revisionNo" >= 1 AND "bidValidityDays" > 0 AND "minInvites" >= 1
  AND ("estimatedNetSatang" IS NULL OR "estimatedNetSatang" >= 0)
  AND length("title") > 0 AND length("categoryCode") > 0 AND "version" >= 0);

ALTER TABLE "RfxLine" ADD CONSTRAINT rfx_line_shape CHECK (
  "quantity" > 0 AND "lineNo" >= 1
  AND ("refUnitPriceSatang" IS NULL OR "refUnitPriceSatang" > 0)
  AND (("refUnitPriceSatang" IS NULL) = ("refSource" IS NULL))
  AND length("description") > 0 AND length("uom") > 0);

ALTER TABLE "RfxLineSource" ADD CONSTRAINT rfx_line_source_quantity CHECK ("quantity" > 0);

-- An invite names a supplier or an application (ADR-203); a declined or removed one says when
ALTER TABLE "RfxInvite" ADD CONSTRAINT rfx_invite_shape CHECK (
  ("supplierId" IS NOT NULL OR "applicationId" IS NOT NULL)
  AND ("status" <> 'VIEWED' OR "viewedAt" IS NOT NULL)
  AND ("status" <> 'DECLINED' OR "declinedAt" IS NOT NULL)
  AND ("status" <> 'REMOVED' OR ("removedAt" IS NOT NULL AND "removeReason" IS NOT NULL))
  AND "version" >= 0);

-- A question up to 2,000 characters and an answer up to 4,000; an answered one names who answered (BR-RFX-04)
ALTER TABLE "RfxQuestion" ADD CONSTRAINT rfx_question_shape CHECK (
  length("question") BETWEEN 1 AND 2000
  AND ("answer" IS NULL OR length("answer") BETWEEN 1 AND 4000)
  AND ("status" <> 'ANSWERED' OR ("answer" IS NOT NULL AND "answeredById" IS NOT NULL AND "answeredAt" IS NOT NULL))
  AND "version" >= 0);

-- An amendment raises the revision and may only move the close later (BR-RFX-05); amendments are append-only, with
-- S1's bcs_forbid_mutation()
ALTER TABLE "RfxAmendment" ADD CONSTRAINT rfx_amendment_shape CHECK (
  "revisionNo" >= 2 AND length("summary") > 0
  AND ("newClosesAt" IS NULL OR "previousClosesAt" IS NULL OR "newClosesAt" > "previousClosesAt"));
CREATE TRIGGER rfx_amendment_append_only BEFORE UPDATE OR DELETE ON "RfxAmendment"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON "RfxAmendment" FROM bcs_app;
GRANT SELECT, INSERT ON "RfxAmendment" TO bcs_app;

-- gross = net + vat (BR-RFX-08); a submitted bid has its time, rate, validity and revision; one recorder, the contact
-- or procurement on the supplier's behalf (BR-SOD-13); a note up to 2,000 characters
ALTER TABLE "Bid" ADD CONSTRAINT bid_shape CHECK (
  "grossSatang" = "netSatang" + "vatSatang"
  AND "quotedTotalSatang" >= 0 AND "netSatang" >= 0 AND "vatSatang" >= 0
  AND ("vatRateBp" IS NULL OR "vatRateBp" BETWEEN 0 AND 10000)
  AND ("status" <> 'SUBMITTED' OR ("submittedAt" IS NOT NULL AND "vatRateBp" IS NOT NULL AND "validUntil" IS NOT NULL AND "revisionNoAtSubmit" IS NOT NULL))
  AND ("submittedAt" IS NULL OR "submittedByContactId" IS NOT NULL OR "submittedByMemberId" IS NOT NULL)
  AND ("submittedByContactId" IS NULL OR "submittedByMemberId" IS NULL)
  AND ("status" <> 'DISQUALIFIED' OR "disqualifyReason" IS NOT NULL)
  AND ("note" IS NULL OR length("note") <= 2000)
  AND ("deliveryDays" IS NULL OR "deliveryDays" >= 0)
  AND "submitCount" >= 0 AND "version" >= 0);

-- A line not offered has no price; an offered one has a positive price (BR-RFX-08)
ALTER TABLE "BidLine" ADD CONSTRAINT bid_line_shape CHECK (
  ("offered" OR ("unitPriceSatang" IS NULL AND "lineQuotedSatang" IS NULL AND "lineNetSatang" IS NULL))
  AND (NOT "offered" OR ("unitPriceSatang" IS NOT NULL AND "unitPriceSatang" > 0))
  AND ("lineQuotedSatang" IS NULL OR "lineQuotedSatang" >= 0)
  AND ("lineNetSatang" IS NULL OR "lineNetSatang" >= 0)
  AND ("confirmedNetUnitPriceSatang" IS NULL OR "confirmedNetUnitPriceSatang" > 0)
  AND ("leadTimeDays" IS NULL OR "leadTimeDays" >= 0));

ALTER TABLE "Scorecard" ADD CONSTRAINT scorecard_shape CHECK (
  "minEvaluators" >= 1
  AND ("status" = 'DRAFT' OR "lockedAt" IS NOT NULL)
  AND ("status" <> 'REVEALED' OR "revealedAt" IS NOT NULL)
  AND "version" >= 0);

ALTER TABLE "ScorecardEvaluator" ADD CONSTRAINT scorecard_evaluator_shape CHECK (
  ("status" <> 'SUBMITTED' OR "submittedAt" IS NOT NULL)
  AND ("status" <> 'RECUSED' OR "recuseReason" IS NOT NULL));

ALTER TABLE "ScoreCriterion" ADD CONSTRAINT score_criterion_shape CHECK (
  "weightBp" BETWEEN 0 AND 10000 AND length("code") BETWEEN 1 AND 20 AND length("nameTh") > 0);

-- A score is a whole number 0..100; a comment up to 500 characters (BR-RFX-09)
ALTER TABLE "ScoreEntry" ADD CONSTRAINT score_entry_shape CHECK (
  "score" BETWEEN 0 AND 100 AND ("comment" IS NULL OR length("comment") <= 500));

-- gross = net + vat and the amount is positive: RFX_AWARD is a document type of REQUIRED amount (BR-DOA-21 · BR-DOA-27);
-- a submitted award has its number and submitter, a decided one its time
ALTER TABLE "AwardDecision" ADD CONSTRAINT award_decision_shape CHECK (
  "grossSatang" = "netSatang" + "vatSatang"
  AND "netSatang" > 0 AND "vatSatang" >= 0
  AND ("sourceApprovedNetSatang" IS NULL OR "sourceApprovedNetSatang" >= 0)
  AND ("status" IN ('DRAFT', 'CANCELLED') OR ("number" IS NOT NULL AND "submittedById" IS NOT NULL AND "submittedAt" IS NOT NULL))
  AND ("status" NOT IN ('APPROVED', 'REJECTED') OR "decidedAt" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR ("cancelReason" IS NOT NULL AND "cancelledAt" IS NOT NULL))
  AND ("poStatus" = 'NOT_APPLICABLE' OR "status" = 'APPROVED')
  AND "version" >= 0);

ALTER TABLE "AwardLine" ADD CONSTRAINT award_line_shape CHECK (
  "quantity" > 0 AND "unitPriceSatang" >= 0 AND "lineNetSatang" >= 0 AND "vatRateBp" BETWEEN 0 AND 10000);

-- [validFrom, validTo) like PriceAgreement (BR-RFX-14); one from an award names it; an ended one says who and why
ALTER TABLE "PreferredSupplier" ADD CONSTRAINT preferred_supplier_shape CHECK (
  "validTo" > "validFrom"
  AND ("source" <> 'SOURCING' OR "awardDecisionId" IS NOT NULL)
  AND (("endedAt" IS NULL) = ("endedById" IS NULL))
  AND ("endedAt" IS NULL OR "endReason" IS NOT NULL)
  AND length("categoryCode") > 0);

-- BR-FORM-12: a reason, when there is one, is not empty
ALTER TABLE "Request" ADD CONSTRAINT request_preferred_override_reason CHECK (
  "preferredSupplierOverrideReason" IS NULL OR length("preferredSupplierOverrideReason") > 0);
