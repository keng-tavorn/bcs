-- DropForeignKey
ALTER TABLE "FileLink" DROP CONSTRAINT "FileLink_fileId_fkey";

-- DropForeignKey
ALTER TABLE "FileObject" DROP CONSTRAINT "FileObject_uploadedById_fkey";

-- DropForeignKey
ALTER TABLE "MemberInvitation" DROP CONSTRAINT "MemberInvitation_createdById_fkey";

-- DropForeignKey
ALTER TABLE "MemberInvitation" DROP CONSTRAINT "MemberInvitation_memberId_fkey";

-- DropForeignKey
ALTER TABLE "Notification" DROP CONSTRAINT "Notification_recipientMemberId_fkey";

-- DropForeignKey
ALTER TABLE "Organization" DROP CONSTRAINT "Organization_contractSignatoryMemberId_fkey";

-- DropForeignKey
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_grantedById_fkey";

-- DropForeignKey
ALTER TABLE "RoleAssignment" DROP CONSTRAINT "RoleAssignment_memberId_fkey";

-- DropIndex
DROP INDEX "Outbox_sentAt_createdAt_idx";

-- AlterTable
ALTER TABLE "Outbox" ADD COLUMN     "deadAt" TIMESTAMPTZ(6),
ADD COLUMN     "nextAttemptAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_organizationId_id_key" ON "FileObject"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Member_organizationId_id_key" ON "Member"("organizationId", "id");

-- CreateIndex
CREATE INDEX "outbox_due_idx" ON "Outbox"("nextAttemptAt", "createdAt") WHERE ("sentAt" IS NULL AND "deadAt" IS NULL AND NOT "suppressed");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_id_contractSignatoryMemberId_fkey" FOREIGN KEY ("id", "contractSignatoryMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationId_grantedById_fkey" FOREIGN KEY ("organizationId", "grantedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_organizationId_uploadedById_fkey" FOREIGN KEY ("organizationId", "uploadedById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileLink" ADD CONSTRAINT "FileLink_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_recipientMemberId_fkey" FOREIGN KEY ("organizationId", "recipientMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberInvitation" ADD CONSTRAINT "MemberInvitation_organizationId_createdById_fkey" FOREIGN KEY ("organizationId", "createdById") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_authorMemberId_fkey" FOREIGN KEY ("organizationId", "authorMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_organizationId_retractedByMemberId_fkey" FOREIGN KEY ("organizationId", "retractedByMemberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===== Hand-written (spec §4.5, §6.3) =====

-- Event.seq is "bigint identity" (§4.5): Postgres assigns it and rejects client-supplied values, so no caller
-- can reorder the global audit sequence that the daily seal hashes (INV-EVT-03).
ALTER TABLE "Event" ALTER COLUMN "seq" DROP DEFAULT;
DROP SEQUENCE IF EXISTS "Event_seq_seq";
ALTER TABLE "Event" ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY;
DO $$
DECLARE next_seq bigint;
BEGIN
  SELECT COALESCE(MAX("seq"), 0) + 1 INTO next_seq FROM "Event";
  EXECUTE format('ALTER TABLE "Event" ALTER COLUMN "seq" RESTART WITH %s', next_seq);
END $$;

-- Insert time of append-only rows always comes from the database clock (no backdating).
CREATE OR REPLACE FUNCTION bcs_stamp_created_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."createdAt" := now();
  RETURN NEW;
END $$;
CREATE TRIGGER "Event_stamp_created_at" BEFORE INSERT ON "Event" FOR EACH ROW EXECUTE FUNCTION bcs_stamp_created_at();

-- A role is granted by a member, by a PLATFORM_ADMIN, or (demo seed only) by neither, never by both.
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "role_assignment_single_grantor" CHECK (num_nonnulls("grantedById", "grantedByPlatformAdminId") <= 1);
