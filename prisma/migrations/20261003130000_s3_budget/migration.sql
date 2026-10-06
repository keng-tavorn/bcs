-- CreateEnum
CREATE TYPE "FiscalYearStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "BudgetLineStatus" AS ENUM ('OPEN', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "BudgetBucket" AS ENUM ('OUTSIDE', 'AVAILABLE', 'RESERVED', 'COMMITTED', 'ACTUAL');

-- CreateEnum
CREATE TYPE "BudgetSourceType" AS ENUM ('REQUEST_LINE', 'PO_LINE');

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "budgetLineId" UUID;

-- CreateTable
CREATE TABLE "FiscalYear" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "status" "FiscalYearStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FiscalYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLine" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fiscalYearId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "costCenterId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "nameTh" TEXT NOT NULL,
    "accountCode" TEXT,
    "plannedSatang" BIGINT NOT NULL,
    "status" "BudgetLineStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BudgetLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLedgerEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "budgetLineId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "fromBucket" "BudgetBucket" NOT NULL,
    "toBucket" "BudgetBucket" NOT NULL,
    "amountSatang" BIGINT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetLineBalance" (
    "budgetLineId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "availableSatang" BIGINT NOT NULL DEFAULT 0,
    "reservedSatang" BIGINT NOT NULL DEFAULT 0,
    "committedSatang" BIGINT NOT NULL DEFAULT 0,
    "actualSatang" BIGINT NOT NULL DEFAULT 0,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BudgetLineBalance_pkey" PRIMARY KEY ("budgetLineId")
);

-- CreateTable
CREATE TABLE "BudgetAllocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "budgetLineId" UUID NOT NULL,
    "sourceType" "BudgetSourceType" NOT NULL,
    "sourceId" UUID NOT NULL,
    "reservedSatang" BIGINT NOT NULL DEFAULT 0,
    "committedSatang" BIGINT NOT NULL DEFAULT 0,
    "actualSatang" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BudgetAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetGrant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "budgetLineId" UUID NOT NULL,
    "granteeDepartmentId" UUID,
    "granteeMemberId" UUID,
    "validFrom" TIMESTAMPTZ(6) NOT NULL,
    "validTo" TIMESTAMPTZ(6),
    "grantedById" UUID NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BudgetGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetImport" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fiscalYearId" UUID NOT NULL,
    "checksum" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rows" INTEGER NOT NULL,
    "totalSatang" BIGINT NOT NULL,
    "importedById" UUID,
    "confirmedDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "importedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BudgetImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_organizationId_id_key" ON "FiscalYear"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalYear_organizationId_code_key" ON "FiscalYear"("organizationId", "code");

-- CreateIndex
CREATE INDEX "BudgetLine_organizationId_departmentId_idx" ON "BudgetLine"("organizationId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_organizationId_id_key" ON "BudgetLine"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLine_organizationId_fiscalYearId_code_key" ON "BudgetLine"("organizationId", "fiscalYearId", "code");

-- CreateIndex
CREATE INDEX "BudgetLedgerEntry_organizationId_sourceType_sourceId_idx" ON "BudgetLedgerEntry"("organizationId", "sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLedgerEntry_organizationId_id_key" ON "BudgetLedgerEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLedgerEntry_organizationId_budgetLineId_seq_key" ON "BudgetLedgerEntry"("organizationId", "budgetLineId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetLineBalance_organizationId_budgetLineId_key" ON "BudgetLineBalance"("organizationId", "budgetLineId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetAllocation_organizationId_id_key" ON "BudgetAllocation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetAllocation_organizationId_budgetLineId_sourceType_sou_key" ON "BudgetAllocation"("organizationId", "budgetLineId", "sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "BudgetGrant_organizationId_budgetLineId_idx" ON "BudgetGrant"("organizationId", "budgetLineId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetGrant_organizationId_id_key" ON "BudgetGrant"("organizationId", "id");

-- CreateIndex
CREATE INDEX "BudgetImport_organizationId_checksum_idx" ON "BudgetImport"("organizationId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetImport_organizationId_id_key" ON "BudgetImport"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FiscalYear" ADD CONSTRAINT "FiscalYear_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_organizationId_fiscalYearId_fkey" FOREIGN KEY ("organizationId", "fiscalYearId") REFERENCES "FiscalYear"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_organizationId_departmentId_fkey" FOREIGN KEY ("organizationId", "departmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLine" ADD CONSTRAINT "BudgetLine_organizationId_costCenterId_fkey" FOREIGN KEY ("organizationId", "costCenterId") REFERENCES "CostCenter"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLedgerEntry" ADD CONSTRAINT "BudgetLedgerEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLedgerEntry" ADD CONSTRAINT "BudgetLedgerEntry_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLineBalance" ADD CONSTRAINT "BudgetLineBalance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetLineBalance" ADD CONSTRAINT "BudgetLineBalance_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetAllocation" ADD CONSTRAINT "BudgetAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetAllocation" ADD CONSTRAINT "BudgetAllocation_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetGrant" ADD CONSTRAINT "BudgetGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetGrant" ADD CONSTRAINT "BudgetGrant_organizationId_budgetLineId_fkey" FOREIGN KEY ("organizationId", "budgetLineId") REFERENCES "BudgetLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetGrant" ADD CONSTRAINT "BudgetGrant_organizationId_granteeDepartmentId_fkey" FOREIGN KEY ("organizationId", "granteeDepartmentId") REFERENCES "Department"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetGrant" ADD CONSTRAINT "BudgetGrant_organizationId_granteeMemberId_fkey" FOREIGN KEY ("organizationId", "granteeMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetGrant" ADD CONSTRAINT "BudgetGrant_organizationId_grantedById_fkey" FOREIGN KEY ("organizationId", "grantedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetImport" ADD CONSTRAINT "BudgetImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetImport" ADD CONSTRAINT "BudgetImport_organizationId_fiscalYearId_fkey" FOREIGN KEY ("organizationId", "fiscalYearId") REFERENCES "FiscalYear"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BudgetImport" ADD CONSTRAINT "BudgetImport_organizationId_importedById_fkey" FOREIGN KEY ("organizationId", "importedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.3 items 1-3 for the budget, NEW-04, INV-BUD-04 (added after the generated part) =====

-- §6.3 (1): the ledger is append-only (INV-BUD-06, INV-EVT-01); bcs_forbid_mutation() comes from the S1 migration
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON "BudgetLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();

-- §6.3 (2): the app role only reads and appends the ledger
REVOKE UPDATE, DELETE, TRUNCATE ON "BudgetLedgerEntry" FROM bcs_app;
GRANT SELECT, INSERT ON "BudgetLedgerEntry" TO bcs_app;

-- §6.3 (3): money never goes negative (INV-BUD-02)
ALTER TABLE "BudgetLedgerEntry" ADD CONSTRAINT ledger_amount_positive CHECK ("amountSatang" > 0);
ALTER TABLE "BudgetLedgerEntry" ADD CONSTRAINT ledger_buckets_differ CHECK ("fromBucket" <> "toBucket");
ALTER TABLE "BudgetLineBalance" ADD CONSTRAINT balance_non_negative CHECK (
  "availableSatang" >= 0 AND "reservedSatang" >= 0 AND "committedSatang" >= 0 AND "actualSatang" >= 0);
ALTER TABLE "BudgetAllocation" ADD CONSTRAINT allocation_non_negative CHECK (
  "reservedSatang" >= 0 AND "committedSatang" >= 0 AND "actualSatang" >= 0);
ALTER TABLE "BudgetLine" ADD CONSTRAINT budget_line_planned_non_negative CHECK ("plannedSatang" >= 0);
ALTER TABLE "BudgetImport" ADD CONSTRAINT budget_import_total_non_negative CHECK ("totalSatang" >= 0 AND "rows" > 0);
ALTER TABLE "BudgetLedgerEntry" ADD CONSTRAINT ledger_seq_positive CHECK ("seq" > 0);
ALTER TABLE "BudgetLineBalance" ADD CONSTRAINT balance_last_seq_non_negative CHECK ("lastSeq" >= 0);

-- A fiscal year ends on or after it starts; a grant goes to one department or one member, for a period
ALTER TABLE "FiscalYear" ADD CONSTRAINT fiscal_year_period CHECK ("endsOn" >= "startsOn");
ALTER TABLE "BudgetGrant" ADD CONSTRAINT budget_grant_one_grantee CHECK (("granteeDepartmentId" IS NULL) <> ("granteeMemberId" IS NULL));
ALTER TABLE "BudgetGrant" ADD CONSTRAINT budget_grant_period CHECK ("validTo" IS NULL OR "validTo" > "validFrom");

-- INV-BUD-04: every ledger row names an Event of its organization that exists when the transaction commits (the
-- command pipeline appends its events after the ledger rows, so the check waits for the commit)
CREATE OR REPLACE FUNCTION bcs_ledger_event_exists() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = NEW."eventId" AND e."organizationId" = NEW."organizationId") THEN
    RAISE EXCEPTION 'BudgetLedgerEntry %: event % does not exist (INV-BUD-04)', NEW."id", NEW."eventId"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_event_exists AFTER INSERT ON "BudgetLedgerEntry"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bcs_ledger_event_exists();
