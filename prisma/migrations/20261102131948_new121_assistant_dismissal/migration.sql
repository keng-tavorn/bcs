-- CreateTable
CREATE TABLE "AssistantDismissal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "dismissedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AssistantDismissal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistantDismissal_organizationId_id_key" ON "AssistantDismissal"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AssistantDismissal_organizationId_memberId_key_key" ON "AssistantDismissal"("organizationId", "memberId", "key");

-- AddForeignKey
ALTER TABLE "AssistantDismissal" ADD CONSTRAINT "AssistantDismissal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssistantDismissal" ADD CONSTRAINT "AssistantDismissal_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
