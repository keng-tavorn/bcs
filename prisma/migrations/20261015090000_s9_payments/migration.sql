-- CreateEnum
CREATE TYPE "BankAccountOwner" AS ENUM ('SUPPLIER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('CURRENT', 'SAVINGS');

-- CreateEnum
CREATE TYPE "BankAccountStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "BankAccountChangeKind" AS ENUM ('ADD', 'REPLACE', 'CLOSE');

-- CreateEnum
CREATE TYPE "BankAccountChangeSource" AS ENUM ('INTERNAL', 'PORTAL');

-- CreateEnum
CREATE TYPE "BankAccountChangeStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentRunStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'FILE_READY', 'SENT_TO_BANK', 'COMPLETED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentFlag" AS ENUM ('REGISTRY_CHANGED', 'SUPPLIER_INACTIVE', 'RISK_OVERRIDE_EXPIRED', 'PREVIOUSLY_EXPORTED', 'BANK_ACCOUNT_RECENTLY_CHANGED', 'BANK_CHANGE_PENDING', 'SHARED_BANK_ACCOUNT');

-- CreateEnum
CREATE TYPE "PaymentRunItemStatus" AS ENUM ('INCLUDED', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentDocKind" AS ENUM ('INVOICE', 'RETENTION');

-- CreateEnum
CREATE TYPE "PaymentDocStatus" AS ENUM ('HELD', 'PAID', 'RELEASED');

-- CreateEnum
CREATE TYPE "PaymentFileStatus" AS ENUM ('CURRENT', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "FileLinkKind" ADD VALUE 'BANK_PROOF';

-- AlterTable
ALTER TABLE "WhtCertificate" ADD COLUMN     "paymentRunItemId" UUID;

-- AlterTable
ALTER TABLE "WithholdingTax" ADD COLUMN     "paymentRunItemId" UUID;

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "ownerKind" "BankAccountOwner" NOT NULL,
    "supplierId" UUID,
    "code" TEXT,
    "bankCode" TEXT NOT NULL,
    "accountNo" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "branchName" TEXT,
    "accountType" "BankAccountType",
    "status" "BankAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "fileTemplateCode" TEXT,
    "fileParams" JSONB,
    "sourceChangeId" UUID,
    "activatedAt" TIMESTAMPTZ(6),
    "supersededAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccountChange" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "kind" "BankAccountChangeKind" NOT NULL,
    "ownerKind" "BankAccountOwner" NOT NULL,
    "supplierId" UUID,
    "targetBankAccountId" UUID,
    "bankCode" TEXT,
    "accountNo" TEXT,
    "accountName" TEXT,
    "branchName" TEXT,
    "accountType" "BankAccountType",
    "fileTemplateCode" TEXT,
    "fileParams" JSONB,
    "reason" TEXT NOT NULL,
    "callVerifiedAt" TIMESTAMPTZ(6),
    "callVerificationNote" TEXT,
    "source" "BankAccountChangeSource" NOT NULL DEFAULT 'INTERNAL',
    "status" "BankAccountChangeStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedById" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "decidedAt" TIMESTAMPTZ(6),
    "currentRouteId" UUID,
    "appliedBankAccountId" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BankAccountChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "number" TEXT,
    "status" "PaymentRunStatus" NOT NULL DEFAULT 'DRAFT',
    "payDate" DATE NOT NULL,
    "payerBankAccountId" UUID NOT NULL,
    "fileTemplateCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'THB',
    "preparedById" UUID NOT NULL,
    "totalPayableSatang" BIGINT NOT NULL DEFAULT 0,
    "totalWhtSatang" BIGINT NOT NULL DEFAULT 0,
    "totalTransferSatang" BIGINT NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "documentCount" INTEGER NOT NULL DEFAULT 0,
    "flagsKey" TEXT,
    "currentRouteId" UUID,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "sentToBankAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PaymentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRunItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentRunId" UUID NOT NULL,
    "supplierId" UUID NOT NULL,
    "seq" INTEGER,
    "bankAccountId" UUID,
    "payeeBankCode" TEXT,
    "payeeAccountNo" TEXT,
    "payeeAccountName" TEXT,
    "payableSatang" BIGINT NOT NULL DEFAULT 0,
    "whtSatang" BIGINT NOT NULL DEFAULT 0,
    "transferSatang" BIGINT NOT NULL DEFAULT 0,
    "flags" "PaymentFlag"[] DEFAULT ARRAY[]::"PaymentFlag"[],
    "flagReason" TEXT,
    "status" "PaymentRunItemStatus" NOT NULL DEFAULT 'INCLUDED',
    "paidOn" DATE,
    "bankReference" TEXT,
    "failureReason" TEXT,
    "resultRecordedById" UUID,
    "resultRecordedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PaymentRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRunItemWht" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentRunItemId" UUID NOT NULL,
    "incomeType" TEXT NOT NULL,
    "rateBp" INTEGER NOT NULL,
    "baseSatang" BIGINT NOT NULL,
    "whtSatang" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentRunItemWht_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRunDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentRunId" UUID NOT NULL,
    "paymentRunItemId" UUID NOT NULL,
    "docKind" "PaymentDocKind" NOT NULL,
    "invoiceId" UUID,
    "retentionId" UUID,
    "payableSatang" BIGINT NOT NULL,
    "status" "PaymentDocStatus" NOT NULL DEFAULT 'HELD',
    "releaseReason" TEXT,
    "releasedAfterExport" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PaymentRunDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentFile" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "paymentRunId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "templateCode" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "totalSatang" BIGINT NOT NULL,
    "reason" TEXT,
    "status" "PaymentFileStatus" NOT NULL DEFAULT 'CURRENT',
    "generatedById" UUID NOT NULL,
    "generatedAt" TIMESTAMPTZ(6) NOT NULL,
    "firstDownloadedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankAccount_organizationId_bankCode_accountNo_idx" ON "BankAccount"("organizationId", "bankCode", "accountNo");

-- CreateIndex
CREATE INDEX "BankAccount_organizationId_supplierId_status_idx" ON "BankAccount"("organizationId", "supplierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_organizationId_id_key" ON "BankAccount"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_organizationId_code_key" ON "BankAccount"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_one_active_supplier" ON "BankAccount"("organizationId", "supplierId") WHERE (status = 'ACTIVE'::"BankAccountStatus") AND ("ownerKind" = 'SUPPLIER'::"BankAccountOwner");

-- CreateIndex
CREATE INDEX "BankAccountChange_organizationId_status_idx" ON "BankAccountChange"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccountChange_organizationId_id_key" ON "BankAccountChange"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccountChange_organizationId_number_key" ON "BankAccountChange"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_change_one_open_supplier" ON "BankAccountChange"("organizationId", "supplierId") WHERE (status = ANY (ARRAY['DRAFT'::"BankAccountChangeStatus", 'PENDING_APPROVAL'::"BankAccountChangeStatus"]));

-- CreateIndex
CREATE UNIQUE INDEX "bank_account_change_one_open_target" ON "BankAccountChange"("organizationId", "targetBankAccountId") WHERE (status = ANY (ARRAY['DRAFT'::"BankAccountChangeStatus", 'PENDING_APPROVAL'::"BankAccountChangeStatus"]));

-- CreateIndex
CREATE INDEX "PaymentRun_organizationId_status_payDate_idx" ON "PaymentRun"("organizationId", "status", "payDate");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRun_organizationId_id_key" ON "PaymentRun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRun_organizationId_number_key" ON "PaymentRun"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRunItem_organizationId_id_key" ON "PaymentRunItem"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRunItem_organizationId_paymentRunId_supplierId_key" ON "PaymentRunItem"("organizationId", "paymentRunId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRunItem_organizationId_paymentRunId_seq_key" ON "PaymentRunItem"("organizationId", "paymentRunId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRunItemWht_organizationId_id_key" ON "PaymentRunItemWht"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRunItemWht_organizationId_paymentRunItemId_incomeTyp_key" ON "PaymentRunItemWht"("organizationId", "paymentRunItemId", "incomeType", "rateBp");

-- CreateIndex
CREATE INDEX "PaymentRunDocument_organizationId_paymentRunId_idx" ON "PaymentRunDocument"("organizationId", "paymentRunId");

-- CreateIndex
CREATE INDEX "PaymentRunDocument_organizationId_paymentRunItemId_idx" ON "PaymentRunDocument"("organizationId", "paymentRunItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRunDocument_organizationId_id_key" ON "PaymentRunDocument"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_document_live_invoice" ON "PaymentRunDocument"("organizationId", "invoiceId") WHERE (status = ANY (ARRAY['HELD'::"PaymentDocStatus", 'PAID'::"PaymentDocStatus"])) AND ("invoiceId" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "payment_document_live_retention" ON "PaymentRunDocument"("organizationId", "retentionId") WHERE (status = ANY (ARRAY['HELD'::"PaymentDocStatus", 'PAID'::"PaymentDocStatus"])) AND ("retentionId" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentFile_organizationId_id_key" ON "PaymentFile"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentFile_organizationId_paymentRunId_version_key" ON "PaymentFile"("organizationId", "paymentRunId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "payment_file_one_current" ON "PaymentFile"("organizationId", "paymentRunId") WHERE (status = 'CURRENT'::"PaymentFileStatus");

-- CreateIndex
CREATE UNIQUE INDEX "WhtCertificate_organizationId_paymentRunItemId_key" ON "WhtCertificate"("organizationId", "paymentRunItemId");

-- AddForeignKey
ALTER TABLE "WithholdingTax" ADD CONSTRAINT "WithholdingTax_organizationId_paymentRunItemId_fkey" FOREIGN KEY ("organizationId", "paymentRunItemId") REFERENCES "PaymentRunItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "WhtCertificate" ADD CONSTRAINT "WhtCertificate_organizationId_paymentRunItemId_fkey" FOREIGN KEY ("organizationId", "paymentRunItemId") REFERENCES "PaymentRunItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_organizationId_sourceChangeId_fkey" FOREIGN KEY ("organizationId", "sourceChangeId") REFERENCES "BankAccountChange"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_targetBankAccountId_fkey" FOREIGN KEY ("organizationId", "targetBankAccountId") REFERENCES "BankAccount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_appliedBankAccountId_fkey" FOREIGN KEY ("organizationId", "appliedBankAccountId") REFERENCES "BankAccount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_submittedById_fkey" FOREIGN KEY ("organizationId", "submittedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BankAccountChange" ADD CONSTRAINT "BankAccountChange_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_organizationId_payerBankAccountId_fkey" FOREIGN KEY ("organizationId", "payerBankAccountId") REFERENCES "BankAccount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_organizationId_preparedById_fkey" FOREIGN KEY ("organizationId", "preparedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRun" ADD CONSTRAINT "PaymentRun_organizationId_currentRouteId_fkey" FOREIGN KEY ("organizationId", "currentRouteId") REFERENCES "ApprovalRoute"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_organizationId_paymentRunId_fkey" FOREIGN KEY ("organizationId", "paymentRunId") REFERENCES "PaymentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_organizationId_supplierId_fkey" FOREIGN KEY ("organizationId", "supplierId") REFERENCES "Supplier"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_organizationId_bankAccountId_fkey" FOREIGN KEY ("organizationId", "bankAccountId") REFERENCES "BankAccount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT "PaymentRunItem_organizationId_resultRecordedById_fkey" FOREIGN KEY ("organizationId", "resultRecordedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItemWht" ADD CONSTRAINT "PaymentRunItemWht_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunItemWht" ADD CONSTRAINT "PaymentRunItemWht_organizationId_paymentRunItemId_fkey" FOREIGN KEY ("organizationId", "paymentRunItemId") REFERENCES "PaymentRunItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunDocument" ADD CONSTRAINT "PaymentRunDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunDocument" ADD CONSTRAINT "PaymentRunDocument_organizationId_paymentRunId_fkey" FOREIGN KEY ("organizationId", "paymentRunId") REFERENCES "PaymentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunDocument" ADD CONSTRAINT "PaymentRunDocument_organizationId_paymentRunItemId_fkey" FOREIGN KEY ("organizationId", "paymentRunItemId") REFERENCES "PaymentRunItem"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunDocument" ADD CONSTRAINT "PaymentRunDocument_organizationId_invoiceId_fkey" FOREIGN KEY ("organizationId", "invoiceId") REFERENCES "Invoice"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentRunDocument" ADD CONSTRAINT "PaymentRunDocument_organizationId_retentionId_fkey" FOREIGN KEY ("organizationId", "retentionId") REFERENCES "Retention"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentFile" ADD CONSTRAINT "PaymentFile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentFile" ADD CONSTRAINT "PaymentFile_organizationId_paymentRunId_fkey" FOREIGN KEY ("organizationId", "paymentRunId") REFERENCES "PaymentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentFile" ADD CONSTRAINT "PaymentFile_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PaymentFile" ADD CONSTRAINT "PaymentFile_organizationId_generatedById_fkey" FOREIGN KEY ("organizationId", "generatedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===== spec §6.1 and §6.3 for S9 (docs/sub-specs/S9.md "Entity และ migration"; added after the generated part) =====

-- A supplier's account names its supplier, an organization's none (ADR-128); the number is digits only (BR-SUP-07); the
-- name has no control character; an organization's account has its type, and only it carries a file template
ALTER TABLE "BankAccount" ADD CONSTRAINT bank_account_owner CHECK (
  ("ownerKind" = 'SUPPLIER') = ("supplierId" IS NOT NULL)
  AND ("ownerKind" = 'SUPPLIER' OR ("accountType" IS NOT NULL AND "code" IS NOT NULL))
  AND ("ownerKind" = 'ORGANIZATION' OR ("fileTemplateCode" IS NULL AND "fileParams" IS NULL)));
ALTER TABLE "BankAccount" ADD CONSTRAINT bank_account_number CHECK (
  "accountNo" ~ '^[0-9]{10,12}$'
  AND length("accountName") BETWEEN 1 AND 200 AND "accountName" !~ '[[:cntrl:]]'
  AND length("bankCode") > 0 AND "version" >= 0);

-- A request names what it changes: REPLACE and CLOSE a target account, ADD and REPLACE the account proposed (BR-SUP-06)
ALTER TABLE "BankAccountChange" ADD CONSTRAINT bank_account_change_shape CHECK (
  ("ownerKind" = 'SUPPLIER') = ("supplierId" IS NOT NULL)
  AND (("kind" = 'ADD') = ("targetBankAccountId" IS NULL))
  AND ("kind" = 'CLOSE' OR ("bankCode" IS NOT NULL AND "accountNo" IS NOT NULL AND "accountName" IS NOT NULL))
  AND ("accountNo" IS NULL OR "accountNo" ~ '^[0-9]{10,12}$')
  AND ("accountName" IS NULL OR (length("accountName") BETWEEN 1 AND 200 AND "accountName" !~ '[[:cntrl:]]'))
  AND length("reason") > 0 AND "version" >= 0);

-- THB only (NG-9); totals never negative and what is transferred is what is payable less the tax (INV-PAY-02)
ALTER TABLE "PaymentRun" ADD CONSTRAINT payment_run_money CHECK (
  "currency" = 'THB'
  AND "totalPayableSatang" >= 0 AND "totalWhtSatang" >= 0 AND "totalTransferSatang" >= 0
  AND "totalTransferSatang" = "totalPayableSatang" - "totalWhtSatang"
  AND "itemCount" >= 0 AND "documentCount" >= 0 AND "version" >= 0);
ALTER TABLE "PaymentRunItem" ADD CONSTRAINT payment_run_item_money CHECK (
  "payableSatang" >= 0 AND "whtSatang" >= 0 AND "transferSatang" >= 0
  AND "transferSatang" = "payableSatang" - "whtSatang"
  AND ("seq" IS NULL OR "seq" > 0)
  AND ("payeeAccountNo" IS NULL OR "payeeAccountNo" ~ '^[0-9]{10,12}$'));
ALTER TABLE "PaymentRunItemWht" ADD CONSTRAINT payment_run_item_wht_money CHECK (
  "rateBp" >= 0 AND "rateBp" <= 10000 AND "baseSatang" >= 0 AND "whtSatang" >= 0);
-- A document row is an invoice or a retention, never both (BR-PAY-03)
ALTER TABLE "PaymentRunDocument" ADD CONSTRAINT payment_run_document_kind CHECK (
  ("docKind" = 'RETENTION') = ("retentionId" IS NOT NULL)
  AND ("docKind" = 'RETENTION') = ("invoiceId" IS NULL)
  AND "payableSatang" >= 0);
-- Version 1 needs no reason, every later version does (BR-BANK-03)
ALTER TABLE "PaymentFile" ADD CONSTRAINT payment_file_shape CHECK (
  "version" > 0 AND ("version" = 1 OR "reason" IS NOT NULL)
  AND "totalSatang" >= 0 AND "itemCount" >= 0 AND "byteSize" >= 0 AND "sha256" ~ '^[0-9a-f]{64}$');

-- INV-PAY-03 (BR-BANK-03 BR-BANK-08): a bank file is never removed, and its row changes only by becoming SUPERSEDED once
-- and by the time of its first download being set once
CREATE OR REPLACE FUNCTION bcs_payment_file_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PaymentFile is never deleted (INV-PAY-03)' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'firstDownloadedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'firstDownloadedAt') THEN
    RAISE EXCEPTION 'PaymentFile changes only its status and its first download (INV-PAY-03)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (OLD."status" = 'CURRENT' AND NEW."status" = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'PaymentFile goes from CURRENT to SUPERSEDED only (INV-PAY-03)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."firstDownloadedAt" IS DISTINCT FROM OLD."firstDownloadedAt" AND OLD."firstDownloadedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PaymentFile keeps the time of its first download (BR-BANK-08)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payment_file_guard BEFORE UPDATE OR DELETE ON "PaymentFile" FOR EACH ROW EXECUTE FUNCTION bcs_payment_file_guard();
