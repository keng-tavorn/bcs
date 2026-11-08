-- CreateEnum
CREATE TYPE "SupplierContactStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "PortalInviteLinkPurpose" AS ENUM ('INVITATION', 'LOGIN', 'DOCUMENT_REQUEST');

-- CreateEnum
CREATE TYPE "PortalOtpChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "PortalSessionRevokeReason" AS ENUM ('LOGOUT', 'IDLE', 'ABSOLUTE', 'CONTACT_DEACTIVATED', 'SUPPLIER_INACTIVE', 'APPLICATION_CLOSED', 'ADMIN');

-- CreateEnum
CREATE TYPE "SupplierApplicationKind" AS ENUM ('NEW', 'EXISTING');

-- CreateEnum
CREATE TYPE "SupplierApplicationStatus" AS ENUM ('INVITED', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierDocumentStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "PoAcknowledgementKind" AS ENUM ('ACK', 'DELIVERY_UPDATE');

-- CreateEnum
CREATE TYPE "PoSupplierAckStatus" AS ENUM ('NOT_ACKNOWLEDGED', 'ACKNOWLEDGED', 'DELIVERY_UPDATED');

-- CreateEnum
CREATE TYPE "PortalRateLimitScope" AS ENUM ('CONTACT', 'SUPPLIER', 'APPLICATION');

-- CreateEnum
CREATE TYPE "PortalRateLimitBucket" AS ENUM ('LINK', 'OTP', 'UPLOAD', 'INVOICE');

-- AlterEnum
ALTER TYPE "AiAgent" ADD VALUE 'SUPPLIER_ONBOARDING';

-- AlterEnum
ALTER TYPE "AiPurpose" ADD VALUE 'SUPPLIER_DOC_READ';

-- AlterEnum
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'SUPPLIER_APPLICATION';

-- AlterEnum
ALTER TYPE "DoaDocumentType" ADD VALUE 'SUPPLIER_APPROVAL';

-- AlterEnum
ALTER TYPE "FileLinkKind" ADD VALUE 'SUPPLIER_DOC';

-- AlterTable
ALTER TABLE "AgentAction" ADD COLUMN     "appliedByContactId" UUID,
ADD COLUMN     "requestedByContactId" UUID;

-- AlterTable
ALTER TABLE "BankAccountChange" ADD COLUMN     "callVerifiedById" UUID,
ADD COLUMN     "claimedAt" TIMESTAMPTZ(6),
ADD COLUMN     "proposedByContactId" UUID,
ALTER COLUMN "submittedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "actorSupplierContactId" UUID;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "createdByContactId" UUID;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "supplierAckStatus" "PoSupplierAckStatus" NOT NULL DEFAULT 'NOT_ACKNOWLEDGED',
ADD COLUMN     "supplierAcknowledgedAt" TIMESTAMPTZ(6),
ADD COLUMN     "supplierPromisedDeliveryOn" DATE;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "applicationId" UUID,
ADD COLUMN     "onboardedAt" TIMESTAMPTZ(6),
ADD COLUMN     "portalEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SupplierNotice" ADD COLUMN     "applicationId" UUID,
ADD COLUMN     "contactId" UUID,
ALTER COLUMN "supplierId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SupplierContact" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID,
    "applicationId" UUID,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "roleLabel" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'th',
    "portalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "SupplierContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "privacyNoticeAcceptedAt" TIMESTAMPTZ(6),
    "privacyNoticeVersion" TEXT,
    "firstSignedInAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "deactivatedAt" TIMESTAMPTZ(6),
    "anonymizedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SupplierContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalInviteLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "purpose" "PortalInviteLinkPurpose" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdById" UUID,
    "applicationId" UUID,
    "supplierId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalInviteLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalOtpChallenge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "channel" "PortalOtpChannel" NOT NULL DEFAULT 'EMAIL',
    "sentTo" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "usedAt" TIMESTAMPTZ(6),
    "requestIpHash" TEXT NOT NULL,
    "userAgentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalOtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSession" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "sessionHash" TEXT NOT NULL,
    "csrfTokenHash" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedReason" "PortalSessionRevokeReason",
    "userAgentHash" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierApplication" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "kind" "SupplierApplicationKind" NOT NULL,
    "supplierId" UUID,
    "status" "SupplierApplicationStatus" NOT NULL DEFAULT 'INVITED',
    "invitedById" UUID,
    "inviterPhone" TEXT,
    "invitedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastActivityAt" TIMESTAMPTZ(6) NOT NULL,
    "remindedAt" TIMESTAMPTZ(6),
    "escalatedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "filledOnBehalfById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "submittedByContactId" UUID,
    "routedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "approvedSupplierId" UUID,
    "returnReason" TEXT,
    "rejectReason" TEXT,
    "currentRouteId" UUID,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "taxId" TEXT,
    "branchCode" TEXT NOT NULL DEFAULT '00000',
    "isVatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "payeeType" "PayeeType" NOT NULL DEFAULT 'JURISTIC',
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "category" TEXT,
    "whtIncomeTypeCode" TEXT,
    "paymentTermDays" INTEGER,
    "bankCode" TEXT,
    "accountNoEnc" TEXT,
    "accountNoLast4" TEXT,
    "accountName" TEXT,
    "bankBranch" TEXT,
    "registryData" JSONB,
    "registrySource" "RegistrySource",
    "registryCheckedAt" TIMESTAMPTZ(6),
    "duplicateWarnings" JSONB NOT NULL DEFAULT '[]',
    "fieldSources" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SupplierApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDocumentType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "appliesTo" "PayeeType"[],
    "required" BOOLEAN NOT NULL DEFAULT false,
    "validityDays" INTEGER,
    "reminderDaysBefore" INTEGER NOT NULL DEFAULT 30,
    "requiresVerification" BOOLEAN NOT NULL DEFAULT true,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "aiReadable" BOOLEAN NOT NULL DEFAULT false,
    "aiReadablePayeeTypes" "PayeeType"[] DEFAULT ARRAY[]::"PayeeType"[],
    "singleInstance" BOOLEAN NOT NULL DEFAULT true,
    "linkedRiskQuestionCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SupplierDocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID,
    "applicationId" UUID,
    "documentTypeCode" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "docNumber" TEXT,
    "issuer" TEXT,
    "scope" TEXT,
    "scopeKey" TEXT NOT NULL DEFAULT '',
    "issuedOn" DATE NOT NULL,
    "expiresOn" DATE NOT NULL,
    "statedExpiresOn" DATE,
    "status" "SupplierDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedByContactId" UUID,
    "uploadedByMemberId" UUID,
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ(6),
    "rejectReason" TEXT,
    "supersededById" UUID,
    "reminderSentAt" TIMESTAMPTZ(6),
    "expiredAt" TIMESTAMPTZ(6),
    "agentActionId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SupplierDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoAcknowledgement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "revisionNo" INTEGER NOT NULL,
    "supplierId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "kind" "PoAcknowledgementKind" NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL,
    "promisedDeliveryOn" DATE,
    "previousPromisedOn" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PoAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalRateLimit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scopeKind" "PortalRateLimitScope" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "bucket" "PortalRateLimitBucket" NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PortalRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalIpRateLimit" (
    "id" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "bucket" "PortalRateLimitBucket" NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PortalIpRateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierContact_organizationId_supplierId_idx" ON "SupplierContact"("organizationId", "supplierId");

-- CreateIndex
CREATE INDEX "SupplierContact_organizationId_applicationId_idx" ON "SupplierContact"("organizationId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierContact_organizationId_id_key" ON "SupplierContact"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_contact_active_email" ON "SupplierContact"("organizationId", "email") WHERE (status = 'ACTIVE'::"SupplierContactStatus");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_contact_one_primary" ON "SupplierContact"("organizationId", "supplierId") WHERE ("isPrimary" AND (status = 'ACTIVE'::"SupplierContactStatus"));

-- CreateIndex
CREATE INDEX "PortalInviteLink_organizationId_contactId_purpose_idx" ON "PortalInviteLink"("organizationId", "contactId", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "PortalInviteLink_organizationId_id_key" ON "PortalInviteLink"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalInviteLink_organizationId_tokenHash_key" ON "PortalInviteLink"("organizationId", "tokenHash");

-- CreateIndex
CREATE INDEX "PortalOtpChallenge_organizationId_contactId_createdAt_idx" ON "PortalOtpChallenge"("organizationId", "contactId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortalOtpChallenge_organizationId_id_key" ON "PortalOtpChallenge"("organizationId", "id");

-- CreateIndex
CREATE INDEX "PortalSession_organizationId_contactId_revokedAt_idx" ON "PortalSession"("organizationId", "contactId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_organizationId_id_key" ON "PortalSession"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_organizationId_sessionHash_key" ON "PortalSession"("organizationId", "sessionHash");

-- CreateIndex
CREATE INDEX "SupplierApplication_organizationId_status_lastActivityAt_idx" ON "SupplierApplication"("organizationId", "status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "SupplierApplication_organizationId_invitedById_idx" ON "SupplierApplication"("organizationId", "invitedById");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierApplication_organizationId_id_key" ON "SupplierApplication"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierApplication_organizationId_number_key" ON "SupplierApplication"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_application_open_tax_id" ON "SupplierApplication"("organizationId", "taxId", "branchCode") WHERE ((kind = 'NEW'::"SupplierApplicationKind") AND ("taxId" IS NOT NULL) AND (status <> ALL (ARRAY['REJECTED'::"SupplierApplicationStatus", 'EXPIRED'::"SupplierApplicationStatus", 'CANCELLED'::"SupplierApplicationStatus"])));

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDocumentType_organizationId_id_key" ON "SupplierDocumentType"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDocumentType_organizationId_code_key" ON "SupplierDocumentType"("organizationId", "code");

-- CreateIndex
CREATE INDEX "SupplierDocument_organizationId_supplierId_documentTypeCode_idx" ON "SupplierDocument"("organizationId", "supplierId", "documentTypeCode", "status");

-- CreateIndex
CREATE INDEX "SupplierDocument_organizationId_applicationId_idx" ON "SupplierDocument"("organizationId", "applicationId");

-- CreateIndex
CREATE INDEX "SupplierDocument_organizationId_status_expiresOn_idx" ON "SupplierDocument"("organizationId", "status", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierDocument_organizationId_id_key" ON "SupplierDocument"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_document_one_verified" ON "SupplierDocument"("organizationId", "supplierId", "documentTypeCode", "scopeKey") WHERE ((status = 'VERIFIED'::"SupplierDocumentStatus") AND ("supplierId" IS NOT NULL));

-- CreateIndex
CREATE UNIQUE INDEX "supplier_document_one_verified_application" ON "SupplierDocument"("organizationId", "applicationId", "documentTypeCode", "scopeKey") WHERE ((status = 'VERIFIED'::"SupplierDocumentStatus") AND ("supplierId" IS NULL));

-- CreateIndex
CREATE INDEX "PoAcknowledgement_organizationId_poId_createdAt_idx" ON "PoAcknowledgement"("organizationId", "poId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PoAcknowledgement_organizationId_id_key" ON "PoAcknowledgement"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PortalRateLimit_organizationId_scopeKind_scopeKey_bucket_wi_key" ON "PortalRateLimit"("organizationId", "scopeKind", "scopeKey", "bucket", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "PortalIpRateLimit_scopeKey_bucket_windowStart_key" ON "PortalIpRateLimit"("scopeKey", "bucket", "windowStart");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_applicationId_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "SupplierApplication"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_requestedByContactId_fkey" FOREIGN KEY ("organizationId", "requestedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_appliedByContactId_fkey" FOREIGN KEY ("organizationId", "appliedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_createdByContactId_fkey" FOREIGN KEY ("organizationId", "createdByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierNotice" ADD CONSTRAINT "SupplierNotice_organizationId_applicationId_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "SupplierApplication"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierNotice" ADD CONSTRAINT "SupplierNotice_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_proposedByContactId_fkey" FOREIGN KEY ("organizationId", "proposedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_callVerifiedById_fkey" FOREIGN KEY ("organizationId", "callVerifiedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_organizationId_applicationId_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "SupplierApplication"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierContact" ADD CONSTRAINT "SupplierContact_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalInviteLink" ADD CONSTRAINT "PortalInviteLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalInviteLink" ADD CONSTRAINT "PortalInviteLink_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalInviteLink" ADD CONSTRAINT "PortalInviteLink_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalInviteLink" ADD CONSTRAINT "PortalInviteLink_organizationId_applicationId_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "SupplierApplication"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalInviteLink" ADD CONSTRAINT "PortalInviteLink_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOtpChallenge" ADD CONSTRAINT "PortalOtpChallenge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalOtpChallenge" ADD CONSTRAINT "PortalOtpChallenge_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_approvedSupplierId_fkey" FOREIGN KEY ("organizationId", "approvedSupplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_invitedById_fkey" FOREIGN KEY ("organizationId", "invitedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_filledOnBehalfById_fkey" FOREIGN KEY ("organizationId", "filledOnBehalfById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_routedById_fkey" FOREIGN KEY ("organizationId", "routedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_submittedByContactId_fkey" FOREIGN KEY ("organizationId", "submittedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierApplication" ADD CONSTRAINT "SupplierApplication_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocumentType" ADD CONSTRAINT "SupplierDocumentType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_applicationId_fkey" FOREIGN KEY ("organizationId", "applicationId") REFERENCES "SupplierApplication"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_documentTypeCode_fkey" FOREIGN KEY ("organizationId", "documentTypeCode") REFERENCES "SupplierDocumentType"("organizationId", "code") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_uploadedByContactId_fkey" FOREIGN KEY ("organizationId", "uploadedByContactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_uploadedByMemberId_fkey" FOREIGN KEY ("organizationId", "uploadedByMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_verifiedById_fkey" FOREIGN KEY ("organizationId", "verifiedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_supersededById_fkey" FOREIGN KEY ("organizationId", "supersededById") REFERENCES "SupplierDocument"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierDocument" ADD CONSTRAINT "SupplierDocument_organizationId_agentActionId_fkey" FOREIGN KEY ("organizationId", "agentActionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoAcknowledgement" ADD CONSTRAINT "PoAcknowledgement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoAcknowledgement" ADD CONSTRAINT "PoAcknowledgement_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoAcknowledgement" ADD CONSTRAINT "PoAcknowledgement_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoAcknowledgement" ADD CONSTRAINT "PoAcknowledgement_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "SupplierContact"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PortalRateLimit" ADD CONSTRAINT "PortalRateLimit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.1 and §6.3 for S7 (docs/sub-specs/S7.md "Entity และ migration"; added after the generated part) =====
-- The partial uniques (one active contact per email, one primary contact, one open application per tax id, one VERIFIED
-- document per owner, type and scope) are in schema.prisma above; these are the CHECKs and triggers

-- A contact belongs to a supplier or to an application; email in lower case (BR-PORTAL-01)
ALTER TABLE "SupplierContact" ADD CONSTRAINT supplier_contact_owner CHECK (
  ("supplierId" IS NOT NULL OR "applicationId" IS NOT NULL)
  AND "email" = lower("email") AND length("email") BETWEEN 3 AND 320
  AND "locale" IN ('th', 'en')
  AND ("status" = 'ACTIVE' OR "deactivatedAt" IS NOT NULL)
  AND "version" >= 0);

-- Only the sha256 of a token, a code or a session id is kept, in lower-case hex (BR-PORTAL-01 to 03); expiry is not
-- compared with createdAt, which is the database clock while the services count from the business clock (ctx.now)
ALTER TABLE "PortalInviteLink" ADD CONSTRAINT portal_invite_link_token_hash CHECK (
  "tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PortalOtpChallenge" ADD CONSTRAINT portal_otp_challenge_shape CHECK (
  "codeHash" ~ '^[0-9a-f]{64}$' AND "requestIpHash" ~ '^[0-9a-f]{64}$' AND "userAgentHash" ~ '^[0-9a-f]{64}$'
  AND "attempts" >= 0);
ALTER TABLE "PortalSession" ADD CONSTRAINT portal_session_shape CHECK (
  "sessionHash" ~ '^[0-9a-f]{64}$' AND "csrfTokenHash" ~ '^[0-9a-f]{64}$'
  AND "ipHash" ~ '^[0-9a-f]{64}$' AND "userAgentHash" ~ '^[0-9a-f]{64}$'
  AND (("revokedAt" IS NULL) = ("revokedReason" IS NULL)));

-- An EXISTING application names its supplier; a foreign payee has no Thai tax id (BR-SUP-08 · INV-SUP-02); the account
-- number is kept encrypted, only its last 4 digits in clear (BR-SUP-07)
ALTER TABLE "SupplierApplication" ADD CONSTRAINT supplier_application_shape CHECK (
  ("kind" = 'NEW' OR "supplierId" IS NOT NULL)
  AND ("taxId" IS NULL OR "taxId" ~ '^[0-9]{13}$')
  AND ("payeeType" <> 'FOREIGN' OR "taxId" IS NULL)
  AND "branchCode" ~ '^[0-9]{5}$'
  AND ("accountNoLast4" IS NULL OR "accountNoLast4" ~ '^[0-9]{4}$')
  AND (("accountNoEnc" IS NULL) = ("accountNoLast4" IS NULL))
  AND ("paymentTermDays" IS NULL OR "paymentTermDays" >= 0)
  AND length("nameTh") > 0 AND "version" >= 0);

-- BR-SDOC-01
ALTER TABLE "SupplierDocumentType" ADD CONSTRAINT supplier_document_type_shape CHECK (
  ("validityDays" IS NULL OR "validityDays" > 0) AND "reminderDaysBefore" >= 0 AND length("code") > 0 AND "version" >= 0);

-- A document belongs to a supplier or to an application; a VERIFIED one names who verified it, and keeps the name when
-- it later expires or is superseded (BR-SDOC-02 · BR-SDOC-03)
ALTER TABLE "SupplierDocument" ADD CONSTRAINT supplier_document_shape CHECK (
  ("supplierId" IS NOT NULL OR "applicationId" IS NOT NULL)
  AND "expiresOn" >= "issuedOn"
  AND ("status" <> 'VERIFIED' OR ("verifiedById" IS NOT NULL AND "verifiedAt" IS NOT NULL))
  AND ("status" <> 'REJECTED' OR "rejectReason" IS NOT NULL)
  AND "version" >= 0);

-- Acknowledgements are append-only: a new delivery date is a new row (BR-SUP-14 · ADR-188); bcs_forbid_mutation() is S1's
ALTER TABLE "PoAcknowledgement" ADD CONSTRAINT po_acknowledgement_shape CHECK (
  "revisionNo" >= 0
  AND ("note" IS NULL OR length("note") <= 500)
  AND ("promisedDeliveryOn" IS NULL OR "promisedDeliveryOn" >= ("acknowledgedAt" AT TIME ZONE 'Asia/Bangkok')::date));
CREATE TRIGGER po_acknowledgement_append_only BEFORE UPDATE OR DELETE ON "PoAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON "PoAcknowledgement" FROM bcs_app;
GRANT SELECT, INSERT ON "PoAcknowledgement" TO bcs_app;

-- Rate limits (BR-PORTAL-04); per IP only links and codes, keyed by the sha256 of the IP
ALTER TABLE "PortalRateLimit" ADD CONSTRAINT portal_rate_limit_count CHECK ("count" >= 0 AND length("scopeKey") > 0);
ALTER TABLE "PortalIpRateLimit" ADD CONSTRAINT portal_ip_rate_limit_shape CHECK (
  "count" >= 0 AND "scopeKey" ~ '^[0-9a-f]{64}$' AND "bucket" IN ('LINK', 'OTP'));

-- A change from the portal has no member until FINANCE claims it; an internal one, and every change past DRAFT, has one
-- (ADR-190); S9's migration is not edited
ALTER TABLE "BankAccountChange" ADD CONSTRAINT bank_account_change_submitter CHECK (
  ("source" = 'PORTAL' OR "submittedById" IS NOT NULL)
  AND ("status" = 'DRAFT' OR "submittedById" IS NOT NULL)
  AND ("source" = 'PORTAL' OR "proposedByContactId" IS NULL));

-- A notice to a supplier names the supplier, the application or the contact (BR-NOTI-09)
ALTER TABLE "SupplierNotice" ADD CONSTRAINT supplier_notice_recipient CHECK (
  "supplierId" IS NOT NULL OR "applicationId" IS NOT NULL OR "contactId" IS NOT NULL);

-- An event that names a supplier contact is the supplier's own and names no member (INV-SUP-05 · ADR-183)
ALTER TABLE "Event" ADD CONSTRAINT event_supplier_actor CHECK (
  "actorSupplierContactId" IS NULL OR ("actorType" = 'SUPPLIER' AND "actorMemberId" IS NULL));
