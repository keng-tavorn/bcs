-- CreateIndex
CREATE INDEX "Event_organizationId_actorMemberId_seq_idx" ON "Event"("organizationId", "actorMemberId", "seq");
