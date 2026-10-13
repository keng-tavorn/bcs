-- P1-07 shared base (docs/sub-specs/P1.md "Entity และ migration"): new enum values only, used by the lanes after this
-- migration commits. No table, column or data change.

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalSubjectType" ADD VALUE 'BUDGET_TRANSFER';
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'BUDGET_OVERRUN';
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'WORKFLOW_VERSION';
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'INVOICE';
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'PO_CHANGE';
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'PAYMENT_RUN';
ALTER TYPE "ApprovalSubjectType" ADD VALUE 'BANK_ACCOUNT_CHANGE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DoaDocumentType" ADD VALUE 'BUDGET_TRANSFER';
ALTER TYPE "DoaDocumentType" ADD VALUE 'OVER_BUDGET';
ALTER TYPE "DoaDocumentType" ADD VALUE 'INVOICE_EXCEPTION';
ALTER TYPE "DoaDocumentType" ADD VALUE 'PO_CHANGE';
ALTER TYPE "DoaDocumentType" ADD VALUE 'PAYMENT_RUN';
ALTER TYPE "DoaDocumentType" ADD VALUE 'BANK_ACCOUNT_CHANGE';
