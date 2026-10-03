-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "authorMemberId" UUID,
    "body" TEXT NOT NULL,
    "retractedAt" TIMESTAMPTZ(6),
    "retractedByMemberId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Comment_organizationId_subjectType_subjectId_idx" ON "Comment"("organizationId", "subjectType", "subjectId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
