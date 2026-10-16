-- CreateEnum
CREATE TYPE "BacktestRunStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subjectType" "ApprovalSubjectType" NOT NULL,
    "subjectId" UUID NOT NULL,
    "status" "BacktestRunStatus" NOT NULL DEFAULT 'PENDING',
    "documentCount" INTEGER NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "requestedById" UUID NOT NULL,
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BacktestRun_organizationId_subjectType_subjectId_createdAt_idx" ON "BacktestRun"("organizationId", "subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BacktestRun_organizationId_id_key" ON "BacktestRun"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BacktestRun" ADD CONSTRAINT "BacktestRun_organizationId_requestedById_fkey" FOREIGN KEY ("organizationId", "requestedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- S6-07 (ADR-111): a backtest tries a DOA or a workflow draft, over a count of documents
ALTER TABLE "BacktestRun" ADD CONSTRAINT backtest_run_subject CHECK ("subjectType" IN ('DOA_VERSION', 'WORKFLOW_VERSION'));
ALTER TABLE "BacktestRun" ADD CONSTRAINT backtest_run_document_count CHECK ("documentCount" >= 0);
