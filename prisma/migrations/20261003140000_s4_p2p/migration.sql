-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "RegistrySource" AS ENUM ('RD', 'DBD', 'MANUAL', 'STUB');

-- CreateEnum
CREATE TYPE "LineKind" AS ENUM ('GOODS', 'SERVICE');

-- CreateEnum
CREATE TYPE "PoStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PoCancelDisposition" AS ENUM ('RETURN_TO_POOL', 'CANCEL_REQUEST_LINES');

-- CreateEnum
CREATE TYPE "ConsolidationTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'URGENT');

-- CreateEnum
CREATE TYPE "ConsolidationRunStatus" AS ENUM ('COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "GrStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "VarianceType" AS ENUM ('SHORT', 'OVER', 'DAMAGED');

-- CreateEnum
CREATE TYPE "VarianceDisposition" AS ENUM ('ACCEPT_EXCESS', 'RETURN_EXCESS', 'ACCEPT_DAMAGED', 'RETURN_REPLACE', 'CLOSE_SHORT');

-- CreateEnum
CREATE TYPE "VarianceStatus" AS ENUM ('RECORDED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('MANUAL', 'ETAX_XML');

-- CreateEnum
CREATE TYPE "ExportKind" AS ENUM ('EXPRESS_AP', 'REPORT', 'AUDIT');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('XLSX', 'CSV');

-- CreateEnum
CREATE TYPE "ActionTokenChannel" AS ENUM ('LINE', 'EMAIL');

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "deliverySiteId" UUID,
ADD COLUMN     "suggestedSupplierId" UUID;

-- AlterTable
ALTER TABLE "RequestLine" ADD COLUMN     "kind" "LineKind" NOT NULL DEFAULT 'GOODS',
ADD COLUMN     "supplierId" UUID;

-- AlterTable
ALTER TABLE "RequestQuotation" ADD COLUMN     "supplierId" UUID;

-- CreateTable
CREATE TABLE "Supplier" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "nameEn" TEXT,
    "taxId" TEXT,
    "branchCode" TEXT NOT NULL DEFAULT '00000',
    "isVatRegistered" BOOLEAN NOT NULL DEFAULT true,
    "isForeign" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "category" TEXT,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "expressVendorCode" TEXT,
    "registryStatus" TEXT,
    "registrySource" "RegistrySource",
    "registryCheckedAt" TIMESTAMPTZ(6),
    "registryData" JSONB,
    "createdById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverySite" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "DeliverySite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "status" "PoStatus" NOT NULL DEFAULT 'DRAFT',
    "supplierId" UUID NOT NULL,
    "deliverySiteId" UUID,
    "kind" "LineKind" NOT NULL DEFAULT 'GOODS',
    "urgency" "Urgency" NOT NULL DEFAULT 'NORMAL',
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "priceIncludesVat" BOOLEAN NOT NULL DEFAULT false,
    "netSatang" BIGINT NOT NULL DEFAULT 0,
    "vatSatang" BIGINT NOT NULL DEFAULT 0,
    "grossSatang" BIGINT NOT NULL DEFAULT 0,
    "vatRateBp" INTEGER,
    "taxPointDate" DATE,
    "paymentTermDays" INTEGER,
    "notesToSupplier" TEXT,
    "createdById" UUID,
    "consolidationRunId" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "sentToEmail" TEXT,
    "sendBouncedAt" TIMESTAMPTZ(6),
    "sendBounceReason" TEXT,
    "closedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" TEXT,
    "cancelDisposition" "PoCancelDisposition",
    "pdfFileId" UUID,
    "currentRouteId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "categoryCode" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL,
    "unitPriceSatang" BIGINT NOT NULL,
    "netSatang" BIGINT NOT NULL,
    "vatable" BOOLEAN NOT NULL DEFAULT true,
    "budgetLineId" UUID NOT NULL,
    "receivedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "acceptedExtraQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cancelledQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "serviceEndDate" DATE,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PoLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoLineSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poLineId" UUID NOT NULL,
    "requestLineId" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "releasableSatang" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PoLineSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsolidationRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "trigger" "ConsolidationTrigger" NOT NULL,
    "scheduledFor" TIMESTAMPTZ(6),
    "ranAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "ConsolidationRunStatus" NOT NULL,
    "createdPoIds" UUID[],
    "triggeredById" UUID,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ConsolidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "poId" UUID NOT NULL,
    "status" "GrStatus" NOT NULL DEFAULT 'DRAFT',
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "receiverMemberId" UUID NOT NULL,
    "deliveryNoteNo" TEXT,
    "notes" TEXT,
    "postedAt" TIMESTAMPTZ(6),
    "reversedAt" TIMESTAMPTZ(6),
    "reverseReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "grId" UUID NOT NULL,
    "poLineId" UUID NOT NULL,
    "receivedQuantity" DECIMAL(18,4) NOT NULL,
    "acceptedQuantity" DECIMAL(18,4) NOT NULL,
    "rejectedQuantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "remark" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GrLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variance" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "poLineId" UUID NOT NULL,
    "grId" UUID,
    "type" "VarianceType" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "amountSatang" BIGINT NOT NULL,
    "disposition" "VarianceDisposition" NOT NULL,
    "status" "VarianceStatus" NOT NULL,
    "reason" TEXT,
    "createdById" UUID NOT NULL,
    "currentRouteId" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Variance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceConfirmation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "poId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "invoiceNoNormalized" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "netSatang" BIGINT NOT NULL,
    "vatSatang" BIGINT NOT NULL,
    "grossSatang" BIGINT NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "sourceFileId" UUID,
    "parsedFrom" "InvoiceSource" NOT NULL DEFAULT 'MANUAL',
    "recordedById" UUID NOT NULL,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL,
    "exportedAt" TIMESTAMPTZ(6),
    "exportJobId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InvoiceConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLineAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "poLineId" UUID NOT NULL,
    "netSatang" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "InvoiceLineAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "ExportKind" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "fileId" UUID,
    "rowCount" INTEGER,
    "totalSatang" BIGINT,
    "checksum" TEXT,
    "reason" TEXT,
    "requestedById" UUID NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reportCode" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "recipients" UUID[],
    "format" "ReportFormat" NOT NULL DEFAULT 'XLSX',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID NOT NULL,
    "lastRunAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionToken" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "allowedActions" TEXT[],
    "channel" "ActionTokenChannel" NOT NULL,
    "secretHash" TEXT,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ActionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_id_key" ON "Supplier"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_code_key" ON "Supplier"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_organizationId_taxId_branchCode_key" ON "Supplier"("organizationId", "taxId", "branchCode");

-- CreateIndex
CREATE UNIQUE INDEX "DeliverySite_organizationId_id_key" ON "DeliverySite"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DeliverySite_organizationId_code_key" ON "DeliverySite"("organizationId", "code");

-- CreateIndex
CREATE INDEX "PurchaseOrder_organizationId_status_idx" ON "PurchaseOrder"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_organizationId_supplierId_idx" ON "PurchaseOrder"("organizationId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_id_key" ON "PurchaseOrder"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_organizationId_number_key" ON "PurchaseOrder"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PoLine_organizationId_id_key" ON "PoLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PoLine_organizationId_poId_lineNo_key" ON "PoLine"("organizationId", "poId", "lineNo");

-- CreateIndex
CREATE INDEX "PoLineSource_organizationId_requestLineId_idx" ON "PoLineSource"("organizationId", "requestLineId");

-- CreateIndex
CREATE UNIQUE INDEX "PoLineSource_organizationId_id_key" ON "PoLineSource"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PoLineSource_organizationId_poLineId_requestLineId_key" ON "PoLineSource"("organizationId", "poLineId", "requestLineId");

-- CreateIndex
CREATE INDEX "ConsolidationRun_organizationId_ranAt_idx" ON "ConsolidationRun"("organizationId", "ranAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConsolidationRun_organizationId_id_key" ON "ConsolidationRun"("organizationId", "id");

-- CreateIndex
CREATE INDEX "GoodsReceipt_organizationId_poId_idx" ON "GoodsReceipt"("organizationId", "poId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_id_key" ON "GoodsReceipt"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_organizationId_number_key" ON "GoodsReceipt"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "GrLine_organizationId_id_key" ON "GrLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GrLine_organizationId_grId_poLineId_key" ON "GrLine"("organizationId", "grId", "poLineId");

-- CreateIndex
CREATE INDEX "Variance_organizationId_poId_idx" ON "Variance"("organizationId", "poId");

-- CreateIndex
CREATE INDEX "Variance_organizationId_status_idx" ON "Variance"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Variance_organizationId_id_key" ON "Variance"("organizationId", "id");

-- CreateIndex
CREATE INDEX "InvoiceConfirmation_organizationId_poId_idx" ON "InvoiceConfirmation"("organizationId", "poId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceConfirmation_organizationId_id_key" ON "InvoiceConfirmation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceConfirmation_organizationId_supplierId_invoiceNoNorm_key" ON "InvoiceConfirmation"("organizationId", "supplierId", "invoiceNoNormalized");

-- CreateIndex
CREATE INDEX "InvoiceLineAllocation_organizationId_poLineId_idx" ON "InvoiceLineAllocation"("organizationId", "poLineId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineAllocation_organizationId_id_key" ON "InvoiceLineAllocation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineAllocation_organizationId_invoiceId_poLineId_key" ON "InvoiceLineAllocation"("organizationId", "invoiceId", "poLineId");

-- CreateIndex
CREATE INDEX "ExportJob_organizationId_kind_createdAt_idx" ON "ExportJob"("organizationId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExportJob_organizationId_id_key" ON "ExportJob"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSchedule_organizationId_id_key" ON "ReportSchedule"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ActionToken_organizationId_taskId_idx" ON "ActionToken"("organizationId", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionToken_organizationId_id_key" ON "ActionToken"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_deliverySiteId_fkey" FOREIGN KEY ("organizationId", "deliverySiteId") REFERENCES "DeliverySite"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_suggestedSupplierId_fkey" FOREIGN KEY ("organizationId", "suggestedSupplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RequestQuotation" ADD CONSTRAINT "RequestQuotation_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DeliverySite" ADD CONSTRAINT "DeliverySite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_deliverySiteId_fkey" FOREIGN KEY ("organizationId", "deliverySiteId") REFERENCES "DeliverySite"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_consolidationRunId_fkey" FOREIGN KEY ("organizationId", "consolidationRunId") REFERENCES "ConsolidationRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_pdfFileId_fkey" FOREIGN KEY ("organizationId", "pdfFileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoLine" ADD CONSTRAINT "PoLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoLine" ADD CONSTRAINT "PoLine_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoLine" ADD CONSTRAINT "PoLine_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoLineSource" ADD CONSTRAINT "PoLineSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoLineSource" ADD CONSTRAINT "PoLineSource_organizationId_poLineId_fkey" FOREIGN KEY ("organizationId", "poLineId") REFERENCES "PoLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PoLineSource" ADD CONSTRAINT "PoLineSource_organizationId_requestLineId_fkey" FOREIGN KEY ("organizationId", "requestLineId") REFERENCES "RequestLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConsolidationRun" ADD CONSTRAINT "ConsolidationRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ConsolidationRun" ADD CONSTRAINT "ConsolidationRun_organizationId_triggeredById_fkey" FOREIGN KEY ("organizationId", "triggeredById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_organizationId_receiverMemberId_fkey" FOREIGN KEY ("organizationId", "receiverMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GrLine" ADD CONSTRAINT "GrLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GrLine" ADD CONSTRAINT "GrLine_organizationId_grId_fkey" FOREIGN KEY ("organizationId", "grId") REFERENCES "GoodsReceipt"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "GrLine" ADD CONSTRAINT "GrLine_organizationId_poLineId_fkey" FOREIGN KEY ("organizationId", "poLineId") REFERENCES "PoLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variance" ADD CONSTRAINT "Variance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variance" ADD CONSTRAINT "Variance_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variance" ADD CONSTRAINT "Variance_organizationId_poLineId_fkey" FOREIGN KEY ("organizationId", "poLineId") REFERENCES "PoLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variance" ADD CONSTRAINT "Variance_organizationId_grId_fkey" FOREIGN KEY ("organizationId", "grId") REFERENCES "GoodsReceipt"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variance" ADD CONSTRAINT "Variance_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Variance" ADD CONSTRAINT "Variance_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT "InvoiceConfirmation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT "InvoiceConfirmation_organizationId_poId_fkey" FOREIGN KEY ("organizationId", "poId") REFERENCES "PurchaseOrder"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT "InvoiceConfirmation_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT "InvoiceConfirmation_organizationId_sourceFileId_fkey" FOREIGN KEY ("organizationId", "sourceFileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT "InvoiceConfirmation_organizationId_recordedById_fkey" FOREIGN KEY ("organizationId", "recordedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT "InvoiceConfirmation_organizationId_exportJobId_fkey" FOREIGN KEY ("organizationId", "exportJobId") REFERENCES "ExportJob"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLineAllocation" ADD CONSTRAINT "InvoiceLineAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLineAllocation" ADD CONSTRAINT "InvoiceLineAllocation_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "InvoiceConfirmation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLineAllocation" ADD CONSTRAINT "InvoiceLineAllocation_organizationId_poLineId_fkey" FOREIGN KEY ("organizationId", "poLineId") REFERENCES "PoLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_organizationId_requestedById_fkey" FOREIGN KEY ("organizationId", "requestedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActionToken" ADD CONSTRAINT "ActionToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActionToken" ADD CONSTRAINT "ActionToken_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActionToken" ADD CONSTRAINT "ActionToken_organizationId_taskId_fkey" FOREIGN KEY ("organizationId", "taskId") REFERENCES "ApprovalTask"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.1 and §6.3 item 3 for purchasing (added after the generated part) =====

-- Money never goes negative (ADR-018); a document's total is its amount before VAT plus VAT
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT po_money_non_negative CHECK (
  "netSatang" >= 0 AND "vatSatang" >= 0 AND "grossSatang" >= 0 AND "grossSatang" = "netSatang" + "vatSatang");
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT po_terms_non_negative CHECK (
  ("vatRateBp" IS NULL OR "vatRateBp" >= 0) AND ("paymentTermDays" IS NULL OR "paymentTermDays" >= 0));
ALTER TABLE "PoLine" ADD CONSTRAINT po_line_money_non_negative CHECK ("unitPriceSatang" >= 0 AND "netSatang" >= 0);
ALTER TABLE "PoLine" ADD CONSTRAINT po_line_quantities CHECK (
  "quantity" > 0 AND "receivedQuantity" >= 0 AND "acceptedExtraQuantity" >= 0
  AND "cancelledQuantity" >= 0 AND "cancelledQuantity" <= "quantity");
ALTER TABLE "PoLineSource" ADD CONSTRAINT po_line_source_amounts CHECK ("quantity" > 0 AND "releasableSatang" >= 0);
ALTER TABLE "Variance" ADD CONSTRAINT variance_amounts CHECK ("quantity" > 0 AND "amountSatang" >= 0);
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT invoice_money_non_negative CHECK (
  "netSatang" >= 0 AND "vatSatang" >= 0 AND "grossSatang" >= 0 AND "grossSatang" = "netSatang" + "vatSatang");
ALTER TABLE "InvoiceConfirmation" ADD CONSTRAINT invoice_number_present CHECK (
  length("invoiceNoNormalized") > 0 AND "invoiceNoNormalized" !~ '\s');
ALTER TABLE "InvoiceLineAllocation" ADD CONSTRAINT invoice_allocation_non_negative CHECK ("netSatang" >= 0);
ALTER TABLE "ExportJob" ADD CONSTRAINT export_job_counts_non_negative CHECK ("totalSatang" >= 0 AND "rowCount" >= 0);

-- BR-GR-01: what came is what was accepted plus what was rejected
ALTER TABLE "GrLine" ADD CONSTRAINT gr_line_quantities CHECK (
  "receivedQuantity" >= 0 AND "acceptedQuantity" >= 0 AND "rejectedQuantity" >= 0
  AND "acceptedQuantity" + "rejectedQuantity" = "receivedQuantity");

-- BR-TAXID-01: a Thai supplier has a 13-digit tax id (mod-11 is checked by core/thai) and a 5-digit branch
ALTER TABLE "Supplier" ADD CONSTRAINT supplier_tax_id_shape CHECK (
  ("isForeign" OR ("taxId" IS NOT NULL AND "taxId" ~ '^[0-9]{13}$')) AND "branchCode" ~ '^[0-9]{5}$');

-- BR-TOK-03: an email link always has a secret, kept only as its sha256
ALTER TABLE "ActionToken" ADD CONSTRAINT action_token_email_secret CHECK ("channel" <> 'EMAIL' OR "secretHash" IS NOT NULL);
