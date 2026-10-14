-- S13-12: an invoice drafted from a reading names its AgentAction (same organization, docs/sub-specs/S13.md)
-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_agentActionId_fkey" FOREIGN KEY ("organizationId", "agentActionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
