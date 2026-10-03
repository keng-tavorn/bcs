-- CreateIndex
-- A scheduled consolidation round runs once per slot of the organization cron (FR-P2P-002 AC2)
CREATE UNIQUE INDEX "consolidation_run_one_per_slot" ON "ConsolidationRun"("organizationId", "scheduledFor") WHERE ("trigger" = 'SCHEDULED');
