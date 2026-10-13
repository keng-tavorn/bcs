-- CreateEnum
CREATE TYPE "InvoiceChannel" AS ENUM ('EMAIL', 'UPLOAD', 'PORTAL');

-- CreateEnum
CREATE TYPE "InvoicePrefill" AS ENUM ('MANUAL', 'ETAX_XML', 'AI_READING');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('INVOICE');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'EXCEPTION', 'PENDING_APPROVAL', 'READY_FOR_PAYMENT', 'IN_PAYMENT_RUN', 'PAID', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceMatchResult" AS ENUM ('MATCHED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "InvoiceLineMatchStatus" AS ENUM ('PENDING', 'MATCHED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "CodingSource" AS ENUM ('HISTORY', 'BUDGET_LINE', 'MANUAL', 'NONE');

-- CreateEnum
CREATE TYPE "MatchTrigger" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MatchExceptionType" AS ENUM ('PRICE_OVER', 'QTY_NOT_RECEIVED', 'QTY_OVER_ORDERED', 'ACCEPTANCE_PENDING', 'VAT_MISMATCH', 'VAT_SUPPLIER_NOT_REGISTERED', 'POSSIBLE_DUPLICATE', 'BUDGET_SHORT');

-- CreateEnum
CREATE TYPE "ExceptionAssigneeRole" AS ENUM ('PROCUREMENT', 'RECEIVER', 'FINANCE');

-- CreateEnum
CREATE TYPE "MatchExceptionStatus" AS ENUM ('OPEN', 'ACCEPT_REQUESTED', 'APPROVED', 'RESOLVED', 'DISMISSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "InboundEmailStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "WhtIncomeTypeForm" AS ENUM ('PND3_53', 'PND53', 'PND3');

-- CreateEnum
CREATE TYPE "WhtReturnForm" AS ENUM ('PND3', 'PND53');

-- CreateEnum
CREATE TYPE "AccountCodeType" AS ENUM ('COST', 'EXPENSE', 'ASSET', 'LIABILITY');

-- CreateEnum
CREATE TYPE "PayeeType" AS ENUM ('JURISTIC', 'INDIVIDUAL', 'FOREIGN');

-- CreateEnum
CREATE TYPE "RegistryFlag" AS ENUM ('NONE', 'CEASED', 'VAT_CANCELLED', 'NOT_FOUND');

-- CreateEnum
CREATE TYPE "ETaxIssuer" AS ENUM ('NONE', 'EMAIL', 'FULL');

-- CreateEnum
CREATE TYPE "PoInvoiceTrack" AS ENUM ('CONFIRMATION', 'MATCHING');

-- CreateEnum
CREATE TYPE "RetentionStatus" AS ENUM ('HELD', 'RELEASABLE', 'IN_PAYMENT_RUN', 'PAID');

-- CreateEnum
CREATE TYPE "PoChangeStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierNoticeStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NO_EMAIL');

-- AlterEnum
ALTER TYPE "ExportKind" ADD VALUE 'WHT_RETURN';

-- AlterEnum
ALTER TYPE "FileLinkKind" ADD VALUE 'WHT_CERT';

-- AlterTable
ALTER TABLE "PoLine" ADD COLUMN     "milestoneNo" INTEGER,
ADD COLUMN     "milestoneShareBp" INTEGER;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "invoiceTrack" "PoInvoiceTrack",
ADD COLUMN     "retentionBp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retentionHoldDays" INTEGER,
ADD COLUMN     "revisionNo" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "RequestType" ADD COLUMN     "defaultRetentionBp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "defaultRetentionHoldDays" INTEGER;

-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "defaultWhtIncomeTypeCode" TEXT,
ADD COLUMN     "eTaxIssuer" "ETaxIssuer" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "payeeType" "PayeeType" NOT NULL DEFAULT 'JURISTIC',
ADD COLUMN     "paymentTermDays" INTEGER,
ADD COLUMN     "registryFlag" "RegistryFlag" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "registryFlaggedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "poId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "channel" "InvoiceChannel" NOT NULL,
    "prefill" "InvoicePrefill" NOT NULL DEFAULT 'MANUAL',
    "fieldSources" JSONB NOT NULL DEFAULT '{}',
    "agentActionId" UUID,
    "inboundEmailId" UUID,
    "sourceFileId" UUID,
    "supplierInvoiceNo" TEXT,
    "supplierInvoiceNoNormalized" TEXT,
    "invoiceDate" DATE,
    "priceIncludesVat" BOOLEAN NOT NULL DEFAULT false,
    "vatRateBp" INTEGER,
    "discountSatang" BIGINT NOT NULL DEFAULT 0,
    "netSatang" BIGINT NOT NULL DEFAULT 0,
    "statedVatSatang" BIGINT NOT NULL DEFAULT 0,
    "computedVatSatang" BIGINT NOT NULL DEFAULT 0,
    "grossSatang" BIGINT NOT NULL DEFAULT 0,
    "retentionBp" INTEGER NOT NULL DEFAULT 0,
    "retentionSatang" BIGINT NOT NULL DEFAULT 0,
    "payableSatang" BIGINT NOT NULL DEFAULT 0,
    "expectedWhtSatang" BIGINT NOT NULL DEFAULT 0,
    "dueDate" DATE,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "kind" "InvoiceKind" NOT NULL DEFAULT 'INVOICE',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "matchResult" "InvoiceMatchResult",
    "createdById" UUID,
    "recordedById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "readyAt" TIMESTAMPTZ(6),
    "rejectedById" UUID,
    "rejectedAt" TIMESTAMPTZ(6),
    "rejectReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" TEXT,
    "currentRouteId" UUID,
    "exportedAt" TIMESTAMPTZ(6),
    "exportJobId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "poLineId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unitPriceSatang" BIGINT NOT NULL,
    "amountSatang" BIGINT NOT NULL DEFAULT 0,
    "discountSatang" BIGINT NOT NULL DEFAULT 0,
    "netSatang" BIGINT NOT NULL DEFAULT 0,
    "vatable" BOOLEAN NOT NULL DEFAULT true,
    "expectedNetSatang" BIGINT NOT NULL DEFAULT 0,
    "overSatang" BIGINT NOT NULL DEFAULT 0,
    "matchStatus" "InvoiceLineMatchStatus" NOT NULL DEFAULT 'PENDING',
    "flags" TEXT[],
    "whtIncomeTypeCode" TEXT,
    "accountCode" TEXT,
    "costCenterId" UUID,
    "codingSource" "CodingSource" NOT NULL DEFAULT 'NONE',
    "costCenterReason" TEXT,
    "codingConfirmedById" UUID,
    "codingConfirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceMatch" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "runNo" INTEGER NOT NULL,
    "ranAt" TIMESTAMPTZ(6) NOT NULL,
    "result" "InvoiceMatchResult" NOT NULL,
    "policy" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "triggeredBy" "MatchTrigger" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchException" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "invoiceMatchId" UUID NOT NULL,
    "invoiceLineId" UUID,
    "type" "MatchExceptionType" NOT NULL,
    "amountSatang" BIGINT NOT NULL,
    "quantity" DECIMAL(18,4),
    "assigneeRole" "ExceptionAssigneeRole" NOT NULL,
    "status" "MatchExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMPTZ(6),
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MatchException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEmail" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "InboundEmailStatus" NOT NULL DEFAULT 'RECEIVED',
    "ignoreReason" TEXT,
    "attachmentCount" INTEGER NOT NULL DEFAULT 0,
    "poRefsFound" TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhtIncomeType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "rateBp" INTEGER NOT NULL,
    "form" "WhtIncomeTypeForm" NOT NULL,
    "legalRefTh" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" UUID,
    "confirmedById" UUID,
    "confirmedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WhtIncomeType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountCode" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "type" "AccountCodeType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AccountCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WithholdingTax" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID,
    "retentionId" UUID,
    "supplierId" UUID NOT NULL,
    "payeeType" "PayeeType" NOT NULL,
    "incomeTypeCode" TEXT NOT NULL,
    "form" "WhtReturnForm" NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "baseSatang" BIGINT NOT NULL,
    "taxSatang" BIGINT NOT NULL,
    "paidOn" DATE NOT NULL,
    "certificateId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WithholdingTax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhtCertificate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplierId" UUID NOT NULL,
    "form" "WhtReturnForm" NOT NULL,
    "paidOn" DATE NOT NULL,
    "totalBaseSatang" BIGINT NOT NULL,
    "totalTaxSatang" BIGINT NOT NULL,
    "payeeSnapshot" JSONB NOT NULL,
    "payerSnapshot" JSONB NOT NULL,
    "fileId" UUID,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WhtCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Retention" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "amountSatang" BIGINT NOT NULL,
    "status" "RetentionStatus" NOT NULL DEFAULT 'HELD',
    "releaseDueOn" DATE,
    "releasedById" UUID,
    "releasedAt" TIMESTAMPTZ(6),
    "paidAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Retention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SensitiveAccessLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "fields" TEXT[],
    "purpose" TEXT NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SensitiveAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoChange" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "changeNo" INTEGER NOT NULL,
    "status" "PoChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "oldNetSatang" BIGINT NOT NULL,
    "oldVatSatang" BIGINT NOT NULL,
    "oldGrossSatang" BIGINT NOT NULL,
    "newNetSatang" BIGINT NOT NULL,
    "newVatSatang" BIGINT NOT NULL,
    "newGrossSatang" BIGINT NOT NULL,
    "notesToSupplier" TEXT,
    "deliveryDate" DATE,
    "quantityDisposition" "PoCancelDisposition",
    "createdById" UUID NOT NULL,
    "submittedById" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "currentRouteId" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "appliedRevisionNo" INTEGER,
    "pdfFileId" UUID,
    "sentAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PoChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoChangeLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poChangeId" UUID NOT NULL,
    "poLineId" UUID NOT NULL,
    "oldQuantity" DECIMAL(18,4) NOT NULL,
    "newQuantity" DECIMAL(18,4) NOT NULL,
    "oldUnitPriceSatang" BIGINT NOT NULL,
    "newUnitPriceSatang" BIGINT NOT NULL,
    "oldNetSatang" BIGINT NOT NULL,
    "newNetSatang" BIGINT NOT NULL,
    "reservedSatang" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PoChangeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierNotice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "toEmail" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'th',
    "data" JSONB NOT NULL DEFAULT '{}',
    "status" "SupplierNoticeStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMPTZ(6),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SupplierNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invoice_organizationId_status_idx" ON "Invoice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_poId_idx" ON "Invoice"("organizationId", "poId");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_dueDate_idx" ON "Invoice"("organizationId", "dueDate");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_supplierId_supplierInvoiceNoNormaliz_idx" ON "Invoice"("organizationId", "supplierId", "supplierInvoiceNoNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_id_key" ON "Invoice"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_organizationId_number_key" ON "Invoice"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_live_supplier_number" ON "Invoice"("organizationId", "supplierId", "supplierInvoiceNoNormalized") WHERE ("status" NOT IN ('DRAFT', 'CANCELLED', 'REJECTED'));

-- CreateIndex
CREATE INDEX "InvoiceLine_organizationId_poLineId_idx" ON "InvoiceLine"("organizationId", "poLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_organizationId_id_key" ON "InvoiceLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_organizationId_invoiceId_lineNo_key" ON "InvoiceLine"("organizationId", "invoiceId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_organizationId_invoiceId_poLineId_key" ON "InvoiceLine"("organizationId", "invoiceId", "poLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceMatch_organizationId_id_key" ON "InvoiceMatch"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceMatch_organizationId_invoiceId_runNo_key" ON "InvoiceMatch"("organizationId", "invoiceId", "runNo");

-- CreateIndex
CREATE INDEX "MatchException_organizationId_status_assigneeRole_idx" ON "MatchException"("organizationId", "status", "assigneeRole");

-- CreateIndex
CREATE INDEX "MatchException_organizationId_invoiceId_idx" ON "MatchException"("organizationId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchException_organizationId_id_key" ON "MatchException"("organizationId", "id");

-- CreateIndex
CREATE INDEX "InboundEmail_organizationId_status_idx" ON "InboundEmail"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_organizationId_id_key" ON "InboundEmail"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEmail_organizationId_messageId_key" ON "InboundEmail"("organizationId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhtIncomeType_organizationId_id_key" ON "WhtIncomeType"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WhtIncomeType_organizationId_code_key" ON "WhtIncomeType"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "AccountCode_organizationId_id_key" ON "AccountCode"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AccountCode_organizationId_code_key" ON "AccountCode"("organizationId", "code");

-- CreateIndex
CREATE INDEX "WithholdingTax_organizationId_supplierId_paidOn_idx" ON "WithholdingTax"("organizationId", "supplierId", "paidOn");

-- CreateIndex
CREATE INDEX "WithholdingTax_organizationId_certificateId_idx" ON "WithholdingTax"("organizationId", "certificateId");

-- CreateIndex
CREATE UNIQUE INDEX "WithholdingTax_organizationId_id_key" ON "WithholdingTax"("organizationId", "id");

-- CreateIndex
CREATE INDEX "WhtCertificate_organizationId_supplierId_idx" ON "WhtCertificate"("organizationId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "WhtCertificate_organizationId_id_key" ON "WhtCertificate"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WhtCertificate_organizationId_number_key" ON "WhtCertificate"("organizationId", "number");

-- CreateIndex
CREATE INDEX "Retention_organizationId_status_releaseDueOn_idx" ON "Retention"("organizationId", "status", "releaseDueOn");

-- CreateIndex
CREATE UNIQUE INDEX "Retention_organizationId_id_key" ON "Retention"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Retention_organizationId_invoiceId_key" ON "Retention"("organizationId", "invoiceId");

-- CreateIndex
CREATE INDEX "SensitiveAccessLog_organizationId_subjectType_subjectId_idx" ON "SensitiveAccessLog"("organizationId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "SensitiveAccessLog_organizationId_id_key" ON "SensitiveAccessLog"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PoChange_organizationId_id_key" ON "PoChange"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PoChange_organizationId_poId_changeNo_key" ON "PoChange"("organizationId", "poId", "changeNo");

-- CreateIndex
CREATE UNIQUE INDEX "po_change_one_open" ON "PoChange"("organizationId", "poId") WHERE ("status" IN ('DRAFT', 'PENDING_APPROVAL'));

-- CreateIndex
CREATE UNIQUE INDEX "PoChangeLine_organizationId_id_key" ON "PoChangeLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PoChangeLine_organizationId_poChangeId_poLineId_key" ON "PoChangeLine"("organizationId", "poChangeId", "poLineId");

-- CreateIndex
CREATE INDEX "SupplierNotice_organizationId_status_idx" ON "SupplierNotice"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierNotice_organizationId_id_key" ON "SupplierNotice"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierNotice_organizationId_dedupeKey_key" ON "SupplierNotice"("organizationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_inboundEmailId_fkey" FOREIGN KEY ("organizationId", "inboundEmailId") REFERENCES "InboundEmail"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_sourceFileId_fkey" FOREIGN KEY ("organizationId", "sourceFileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_recordedById_fkey" FOREIGN KEY ("organizationId", "recordedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_rejectedById_fkey" FOREIGN KEY ("organizationId", "rejectedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_exportJobId_fkey" FOREIGN KEY ("organizationId", "exportJobId") REFERENCES "ExportJob"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_poLineId_fkey" FOREIGN KEY ("organizationId", "poLineId") REFERENCES "PoLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_costCenterId_fkey" FOREIGN KEY ("organizationId", "costCenterId") REFERENCES "CostCenter"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_organizationId_codingConfirmedById_fkey" FOREIGN KEY ("organizationId", "codingConfirmedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceMatch" ADD CONSTRAINT "InvoiceMatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceMatch" ADD CONSTRAINT "InvoiceMatch_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MatchException" ADD CONSTRAINT "MatchException_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MatchException" ADD CONSTRAINT "MatchException_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MatchException" ADD CONSTRAINT "MatchException_organizationId_invoiceMatchId_fkey" FOREIGN KEY ("organizationId", "invoiceMatchId") REFERENCES "InvoiceMatch"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MatchException" ADD CONSTRAINT "MatchException_organizationId_invoiceLineId_fkey" FOREIGN KEY ("organizationId", "invoiceLineId") REFERENCES "InvoiceLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MatchException" ADD CONSTRAINT "MatchException_organizationId_resolvedById_fkey" FOREIGN KEY ("organizationId", "resolvedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InboundEmail" ADD CONSTRAINT "InboundEmail_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtIncomeType" ADD CONSTRAINT "WhtIncomeType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtIncomeType" ADD CONSTRAINT "WhtIncomeType_organizationId_updatedById_fkey" FOREIGN KEY ("organizationId", "updatedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtIncomeType" ADD CONSTRAINT "WhtIncomeType_organizationId_confirmedById_fkey" FOREIGN KEY ("organizationId", "confirmedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AccountCode" ADD CONSTRAINT "AccountCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WithholdingTax" ADD CONSTRAINT "WithholdingTax_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WithholdingTax" ADD CONSTRAINT "WithholdingTax_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WithholdingTax" ADD CONSTRAINT "WithholdingTax_organizationId_retentionId_fkey" FOREIGN KEY ("organizationId", "retentionId") REFERENCES "Retention"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WithholdingTax" ADD CONSTRAINT "WithholdingTax_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WithholdingTax" ADD CONSTRAINT "WithholdingTax_organizationId_certificateId_fkey" FOREIGN KEY ("organizationId", "certificateId") REFERENCES "WhtCertificate"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtCertificate" ADD CONSTRAINT "WhtCertificate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtCertificate" ADD CONSTRAINT "WhtCertificate_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtCertificate" ADD CONSTRAINT "WhtCertificate_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Retention" ADD CONSTRAINT "Retention_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Retention" ADD CONSTRAINT "Retention_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Retention" ADD CONSTRAINT "Retention_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Retention" ADD CONSTRAINT "Retention_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Retention" ADD CONSTRAINT "Retention_organizationId_releasedById_fkey" FOREIGN KEY ("organizationId", "releasedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SensitiveAccessLog" ADD CONSTRAINT "SensitiveAccessLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SensitiveAccessLog" ADD CONSTRAINT "SensitiveAccessLog_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChange" ADD CONSTRAINT "PoChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChange" ADD CONSTRAINT "PoChange_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChange" ADD CONSTRAINT "PoChange_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChange" ADD CONSTRAINT "PoChange_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChange" ADD CONSTRAINT "PoChange_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChange" ADD CONSTRAINT "PoChange_organizationId_pdfFileId_fkey" FOREIGN KEY ("organizationId", "pdfFileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChangeLine" ADD CONSTRAINT "PoChangeLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChangeLine" ADD CONSTRAINT "PoChangeLine_organizationId_poChangeId_fkey" FOREIGN KEY ("organizationId", "poChangeId") REFERENCES "PoChange"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoChangeLine" ADD CONSTRAINT "PoChangeLine_organizationId_poLineId_fkey" FOREIGN KEY ("organizationId", "poLineId") REFERENCES "PoLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierNotice" ADD CONSTRAINT "SupplierNotice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierNotice" ADD CONSTRAINT "SupplierNotice_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.1 and §6.3 for S8 (docs/sub-specs/S8.md "Entity และ migration"; added after the generated part) =====

-- Money never goes negative (ADR-018). An invoice's total is its amount before VAT plus the VAT it states (BR-VAT-07);
-- what is owed is the total less the retention, and the expected withholding tax never exceeds it (INV-AP-04)
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_ap_money CHECK (
  "discountSatang" >= 0 AND "netSatang" >= 0 AND "statedVatSatang" >= 0 AND "computedVatSatang" >= 0
  AND "grossSatang" >= 0 AND "retentionSatang" >= 0 AND "payableSatang" >= 0 AND "expectedWhtSatang" >= 0
  AND "grossSatang" = "netSatang" + "statedVatSatang"
  AND "payableSatang" = "grossSatang" - "retentionSatang"
  AND "expectedWhtSatang" <= "payableSatang");
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_ap_rates CHECK (
  ("vatRateBp" IS NULL OR "vatRateBp" >= 0) AND "retentionBp" >= 0 AND "retentionBp" <= 10000);
-- BR-IVC-03: the normalized number has no spaces
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_ap_number_normalized CHECK (
  "supplierInvoiceNoNormalized" IS NULL OR (length("supplierInvoiceNoNormalized") > 0 AND "supplierInvoiceNoNormalized" !~ '\s'));
-- A submitted invoice has its number, its supplier's number and its date (BR-AP-04)
ALTER TABLE "Invoice" ADD CONSTRAINT invoice_ap_submitted_complete CHECK (
  "status" IN ('DRAFT', 'CANCELLED') OR ("number" IS NOT NULL AND "supplierInvoiceNoNormalized" IS NOT NULL AND "invoiceDate" IS NOT NULL));
ALTER TABLE "InvoiceLine" ADD CONSTRAINT invoice_line_money CHECK (
  "unitPriceSatang" >= 0 AND "amountSatang" >= 0 AND "discountSatang" >= 0 AND "netSatang" >= 0
  AND "expectedNetSatang" >= 0 AND "overSatang" >= 0 AND "quantity" > 0 AND "lineNo" > 0);
ALTER TABLE "InvoiceMatch" ADD CONSTRAINT invoice_match_run_no CHECK ("runNo" > 0);
ALTER TABLE "MatchException" ADD CONSTRAINT match_exception_amounts CHECK (
  "amountSatang" >= 0 AND ("quantity" IS NULL OR "quantity" >= 0));
ALTER TABLE "InboundEmail" ADD CONSTRAINT inbound_email_counts CHECK (
  "attachmentCount" >= 0 AND "attempts" >= 0 AND length("subject") <= 300);
-- The member who confirms a rate is never the member who changed it last (BR-WHT-03)
ALTER TABLE "WhtIncomeType" ADD CONSTRAINT wht_income_type_rate CHECK (
  "rateBp" >= 0 AND "rateBp" <= 10000
  AND ("confirmedById" IS NULL OR "updatedById" IS NULL OR "confirmedById" <> "updatedById"));
-- One document per row: an invoice or a retention (BR-WHT-10)
ALTER TABLE "WithholdingTax" ADD CONSTRAINT withholding_tax_one_document CHECK (("invoiceId" IS NULL) <> ("retentionId" IS NULL));
ALTER TABLE "WithholdingTax" ADD CONSTRAINT withholding_tax_money CHECK (
  "baseSatang" >= 0 AND "taxSatang" >= 0 AND "rateBp" >= 0 AND "rateBp" <= 10000);
ALTER TABLE "WhtCertificate" ADD CONSTRAINT wht_certificate_money CHECK ("totalBaseSatang" >= 0 AND "totalTaxSatang" >= 0);
ALTER TABLE "Retention" ADD CONSTRAINT retention_money CHECK ("amountSatang" >= 0);
ALTER TABLE "PoChange" ADD CONSTRAINT po_change_money CHECK (
  "changeNo" > 0 AND "oldNetSatang" >= 0 AND "oldVatSatang" >= 0 AND "oldGrossSatang" >= 0
  AND "newNetSatang" >= 0 AND "newVatSatang" >= 0 AND "newGrossSatang" >= 0
  AND "oldGrossSatang" = "oldNetSatang" + "oldVatSatang" AND "newGrossSatang" = "newNetSatang" + "newVatSatang"
  AND ("appliedRevisionNo" IS NULL OR "appliedRevisionNo" > 0));
ALTER TABLE "PoChangeLine" ADD CONSTRAINT po_change_line_money CHECK (
  "oldQuantity" > 0 AND "newQuantity" > 0 AND "oldUnitPriceSatang" >= 0 AND "newUnitPriceSatang" >= 0
  AND "oldNetSatang" >= 0 AND "newNetSatang" >= 0 AND "reservedSatang" >= 0);
ALTER TABLE "SupplierNotice" ADD CONSTRAINT supplier_notice_attempts CHECK ("attempts" >= 0);

-- The new columns of existing tables
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT po_s8_terms CHECK (
  "revisionNo" >= 0 AND "retentionBp" >= 0 AND "retentionBp" <= 10000 AND ("retentionHoldDays" IS NULL OR "retentionHoldDays" >= 0));
ALTER TABLE "PoLine" ADD CONSTRAINT po_line_milestone CHECK (
  ("milestoneNo" IS NULL OR "milestoneNo" > 0) AND ("milestoneShareBp" IS NULL OR ("milestoneShareBp" > 0 AND "milestoneShareBp" <= 10000)));
ALTER TABLE "Supplier" ADD CONSTRAINT supplier_payment_term CHECK ("paymentTermDays" IS NULL OR "paymentTermDays" >= 0);
ALTER TABLE "RequestType" ADD CONSTRAINT request_type_retention CHECK (
  "defaultRetentionBp" >= 0 AND "defaultRetentionBp" <= 10000 AND ("defaultRetentionHoldDays" IS NULL OR "defaultRetentionHoldDays" >= 0));

-- SensitiveAccessLog is append-only for the app (§6.2, NFR-PRIV-03): no command edits or removes a row
REVOKE UPDATE, DELETE, TRUNCATE ON "SensitiveAccessLog" FROM bcs_app;
GRANT SELECT, INSERT ON "SensitiveAccessLog" TO bcs_app;
