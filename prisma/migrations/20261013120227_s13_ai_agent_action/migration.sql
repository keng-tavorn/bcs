-- CreateEnum
CREATE TYPE "AiAgent" AS ENUM ('DOCUMENT', 'INTAKE', 'APPROVAL_BRIEF', 'INSIGHT', 'DOA_DRAFTER');

-- CreateEnum
CREATE TYPE "AiPurpose" AS ENUM ('QUOTATION_READ', 'DELIVERY_NOTE_READ', 'INVOICE_READ', 'INTAKE', 'BRIEF', 'QUESTION', 'DOA_DRAFT');

-- CreateEnum
CREATE TYPE "AiLevel" AS ENUM ('L0', 'L1');

-- CreateEnum
CREATE TYPE "AgentActionStatus" AS ENUM ('PENDING', 'DRAFT', 'ACCEPTED', 'EDITED', 'REJECTED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AgentActionFeedback" AS ENUM ('HELPFUL', 'NOT_HELPFUL');

-- CreateEnum
CREATE TYPE "AgentActionExpireReason" AS ENUM ('SUPERSEDED', 'SUBJECT_CLOSED', 'STALE');

-- CreateEnum
CREATE TYPE "AiCreditKind" AS ENUM ('GRANT', 'USE');

-- CreateEnum
CREATE TYPE "AiCreditSource" AS ENUM ('MONTHLY', 'TOPUP', 'CALL');

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agent" "AiAgent" NOT NULL,
    "purpose" "AiPurpose" NOT NULL,
    "level" "AiLevel" NOT NULL,
    "status" "AgentActionStatus" NOT NULL DEFAULT 'PENDING',
    "subjectType" TEXT,
    "subjectId" UUID,
    "requestedById" UUID,
    "channel" "Channel" NOT NULL,
    "conversationId" UUID,
    "promptVersion" TEXT NOT NULL,
    "model" TEXT,
    "inputRefs" JSONB NOT NULL DEFAULT '{}',
    "inputText" TEXT,
    "idempotencyKey" TEXT,
    "output" JSONB,
    "verification" JSONB,
    "fieldConfidence" JSONB,
    "review" JSONB,
    "diff" JSONB,
    "appliedAt" TIMESTAMPTZ(6),
    "appliedById" UUID,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "feedback" "AgentActionFeedback",
    "feedbackNote" TEXT,
    "errorCode" TEXT,
    "expireReason" "AgentActionExpireReason",
    "contentPurgedAt" TIMESTAMPTZ(6),
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costCredits" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAgentSetting" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agent" "AiAgent" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "level" "AiLevel" NOT NULL,
    "minConfidenceBp" INTEGER NOT NULL DEFAULT 9000,
    "updatedById" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AiAgentSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCreditLedger" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "AiCreditKind" NOT NULL,
    "source" "AiCreditSource" NOT NULL,
    "credits" INTEGER NOT NULL,
    "periodMonth" DATE NOT NULL,
    "agentActionId" UUID,
    "platformAdminId" UUID,
    "contractRef" TEXT,
    "reason" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCreditLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentAction_organizationId_subjectType_subjectId_status_idx" ON "AgentAction"("organizationId", "subjectType", "subjectId", "status");

-- CreateIndex
CREATE INDEX "AgentAction_organizationId_agent_createdAt_idx" ON "AgentAction"("organizationId", "agent", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_organizationId_requestedById_createdAt_idx" ON "AgentAction"("organizationId", "requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_organizationId_status_createdAt_idx" ON "AgentAction"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_organizationId_id_key" ON "AgentAction"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_organizationId_idempotencyKey_key" ON "AgentAction"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiAgentSetting_organizationId_id_key" ON "AiAgentSetting"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiAgentSetting_organizationId_agent_key" ON "AiAgentSetting"("organizationId", "agent");

-- CreateIndex
CREATE INDEX "AiCreditLedger_organizationId_periodMonth_idx" ON "AiCreditLedger"("organizationId", "periodMonth");

-- CreateIndex
CREATE UNIQUE INDEX "AiCreditLedger_organizationId_id_key" ON "AiCreditLedger"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AiCreditLedger_organizationId_agentActionId_key" ON "AiCreditLedger"("organizationId", "agentActionId");

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_requestedById_fkey" FOREIGN KEY ("organizationId", "requestedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_appliedById_fkey" FOREIGN KEY ("organizationId", "appliedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_decidedById_fkey" FOREIGN KEY ("organizationId", "decidedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AiAgentSetting" ADD CONSTRAINT "AiAgentSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AiAgentSetting" ADD CONSTRAINT "AiAgentSetting_organizationId_updatedById_fkey" FOREIGN KEY ("organizationId", "updatedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AiCreditLedger" ADD CONSTRAINT "AiCreditLedger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AiCreditLedger" ADD CONSTRAINT "AiCreditLedger_organizationId_agentActionId_fkey" FOREIGN KEY ("organizationId", "agentActionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AiCreditLedger" ADD CONSTRAINT "AiCreditLedger_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.3 for the AI module (S13-02, docs/sub-specs/S13.md "Entity และ migration") =====

-- §6.3 (1): the credit ledger is append-only (BR-AI-23); bcs_forbid_mutation() comes from the S1 migration
CREATE TRIGGER ai_credit_ledger_append_only BEFORE UPDATE OR DELETE ON "AiCreditLedger"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();

-- §6.3 (2): the app role only reads and appends the ledger
REVOKE UPDATE, DELETE, TRUNCATE ON "AiCreditLedger" FROM bcs_app;
GRANT SELECT, INSERT ON "AiCreditLedger" TO bcs_app;

-- §6.3 (3): credits and counts never go negative; a grant row names no action, a use row names exactly one
ALTER TABLE "AiCreditLedger" ADD CONSTRAINT ai_credit_positive CHECK ("credits" > 0);
ALTER TABLE "AiCreditLedger" ADD CONSTRAINT ai_credit_kind_source CHECK (
  ("kind" = 'USE' AND "source" = 'CALL' AND "agentActionId" IS NOT NULL)
  OR ("kind" = 'GRANT' AND "source" IN ('MONTHLY', 'TOPUP') AND "agentActionId" IS NULL));
ALTER TABLE "AiCreditLedger" ADD CONSTRAINT ai_credit_period_first_day CHECK (EXTRACT(DAY FROM "periodMonth") = 1);
-- One monthly grant per organization and month (ai_credit.grant_monthly runs again without a second row)
CREATE UNIQUE INDEX "AiCreditLedger_monthly_once" ON "AiCreditLedger"("organizationId", "periodMonth") WHERE "source" = 'MONTHLY';

ALTER TABLE "AgentAction" ADD CONSTRAINT agent_action_tokens_non_negative CHECK (
  "inputTokens" >= 0 AND "outputTokens" >= 0 AND "cacheReadTokens" >= 0 AND "cacheWriteTokens" >= 0
  AND "costCredits" >= 0 AND ("latencyMs" IS NULL OR "latencyMs" >= 0));
ALTER TABLE "AgentAction" ADD CONSTRAINT agent_action_input_text_length CHECK ("inputText" IS NULL OR char_length("inputText") <= 2000);
ALTER TABLE "AgentAction" ADD CONSTRAINT agent_action_idempotency_key_length CHECK ("idempotencyKey" IS NULL OR char_length("idempotencyKey") <= 200);
ALTER TABLE "AgentAction" ADD CONSTRAINT agent_action_subject_pair CHECK (("subjectType" IS NULL) = ("subjectId" IS NULL));
-- Every action names the prompt it runs, PENDING included (INV-AI-02)
ALTER TABLE "AgentAction" ADD CONSTRAINT agent_action_prompt_version CHECK (char_length("promptVersion") > 0);
ALTER TABLE "AiAgentSetting" ADD CONSTRAINT ai_agent_min_confidence_bp CHECK ("minConfidenceBp" BETWEEN 0 AND 10000);
