-- S17-08 (BR-LINE-13 · ADR-162): the chat draft names the Intake Agent's latest reading of it; additive only (NFR-MNT-04)
-- AlterTable
ALTER TABLE "ChatIntake" ADD COLUMN     "agentActionId" UUID;

-- AddForeignKey
ALTER TABLE "ChatIntake" ADD CONSTRAINT "ChatIntake_organizationId_agentActionId_fkey" FOREIGN KEY ("organizationId", "agentActionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
