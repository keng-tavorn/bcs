-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ModuleKey" AS ENUM ('CORE', 'PAY', 'SUPPLIER', 'SOURCING', 'RISK', 'CONTRACTS', 'AI', 'INTEGRATION', 'DOA_EVERYWHERE', 'BCS_GO');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('INVITED', 'ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "RoleCode" AS ENUM ('PROCUREMENT', 'FINANCE', 'BUDGET_ADMIN', 'RECEIVER', 'EXECUTIVE', 'AUDITOR', 'ORG_ADMIN', 'REVIEWER_IT', 'REVIEWER_LEGAL', 'REVIEWER_FINANCE', 'REVIEWER_INFOSEC');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AI_AGENT', 'SUPPLIER', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WEB', 'LIFF', 'LINE_CHAT', 'PWA', 'EMAIL', 'PORTAL', 'SYSTEM', 'API', 'MCP');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('PENDING', 'AVAILABLE', 'REJECTED');

-- CreateEnum
CREATE TYPE "FileScanStatus" AS ENUM ('NOT_REQUIRED', 'NOT_SCANNED', 'PENDING', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "FileLinkKind" AS ENUM ('QUOTATION', 'DELIVERY_NOTE', 'PHOTO', 'JUSTIFICATION', 'INVOICE', 'PO_PDF', 'DPA', 'ETAX', 'REGISTRY_PROOF', 'OTHER');

-- CreateEnum
CREATE TYPE "NotificationUrgency" AS ENUM ('IMMEDIATE', 'DIGEST');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'LINE', 'EMAIL');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "legalNameTh" TEXT NOT NULL,
    "legalNameEn" TEXT,
    "displayName" TEXT,
    "taxId" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL DEFAULT '00000',
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "locale" TEXT NOT NULL DEFAULT 'th',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "dataRegion" TEXT NOT NULL DEFAULT 'ap-southeast-1',
    "contractSignatoryMemberId" UUID,
    "contractSignatoryVerifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrgModule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "module" "ModuleKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMPTZ(6),
    "disabledAt" TIMESTAMPTZ(6),
    "changedByPlatformAdminId" UUID,
    "contractRef" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrgModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID,
    "displayNameTh" TEXT NOT NULL,
    "displayNameEn" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "employeeCode" TEXT,
    "primaryDepartmentId" UUID,
    "status" "MemberStatus" NOT NULL DEFAULT 'INVITED',
    "transactionPinHash" TEXT,
    "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
    "pinLockedUntil" TIMESTAMPTZ(6),
    "lineReachable" BOOLEAN NOT NULL DEFAULT true,
    "notificationPrefs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "role" "RoleCode" NOT NULL,
    "scopeDepartmentId" UUID,
    "grantedById" UUID,
    "grantedByPlatformAdminId" UUID,
    "grantedAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreakGlassSession" (
    "id" UUID NOT NULL,
    "platformAdminId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "endedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BreakGlassSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "organizationId" UUID,
    "type" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorMemberId" UUID,
    "actorPlatformAdminId" UUID,
    "onBehalfOfMemberId" UUID,
    "agentId" TEXT,
    "channel" "Channel" NOT NULL,
    "doaVersionId" UUID,
    "doaRuleCode" TEXT,
    "correlationId" UUID NOT NULL,
    "causationId" UUID,
    "requestId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "eventName" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sentAt" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandLog" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "commandName" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileObject" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "status" "FileStatus" NOT NULL DEFAULT 'PENDING',
    "uploadedById" UUID,
    "scanStatus" "FileScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FileObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileLink" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" UUID NOT NULL,
    "kind" "FileLinkKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "FileLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recipientMemberId" UUID NOT NULL,
    "templateKey" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "urgency" "NotificationUrgency" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "dedupeKey" TEXT NOT NULL,
    "sentChannel" "NotificationChannel",
    "sentAt" TIMESTAMPTZ(6),
    "readAt" TIMESTAMPTZ(6),
    "error" TEXT,
    "subjectType" TEXT,
    "subjectId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_code_key" ON "Organization"("code");

-- CreateIndex
CREATE INDEX "OrgModule_organizationId_idx" ON "OrgModule"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgModule_organizationId_module_key" ON "OrgModule"("organizationId", "module");

-- CreateIndex
CREATE INDEX "Member_organizationId_idx" ON "Member"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_organizationId_userId_key" ON "Member"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_organizationId_email_key" ON "Member"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Member_organizationId_employeeCode_key" ON "Member"("organizationId", "employeeCode");

-- CreateIndex
CREATE INDEX "RoleAssignment_organizationId_memberId_idx" ON "RoleAssignment"("organizationId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignment_active_unique" ON "RoleAssignment"("organizationId", "memberId", "role") WHERE ("revokedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_userId_key" ON "PlatformAdmin"("userId");

-- CreateIndex
CREATE INDEX "BreakGlassSession_organizationId_idx" ON "BreakGlassSession"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Event_seq_key" ON "Event"("seq");

-- CreateIndex
CREATE INDEX "Event_organizationId_aggregateType_aggregateId_seq_idx" ON "Event"("organizationId", "aggregateType", "aggregateId", "seq");

-- CreateIndex
CREATE INDEX "Event_organizationId_type_occurredAt_idx" ON "Event"("organizationId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "Event_correlationId_idx" ON "Event"("correlationId");

-- CreateIndex
CREATE INDEX "Outbox_organizationId_idx" ON "Outbox"("organizationId");

-- CreateIndex
CREATE INDEX "Outbox_sentAt_createdAt_idx" ON "Outbox"("sentAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommandLog_organizationId_idempotencyKey_key" ON "CommandLog"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "FileObject_storageKey_key" ON "FileObject"("storageKey");

-- CreateIndex
CREATE INDEX "FileObject_organizationId_idx" ON "FileObject"("organizationId");

-- CreateIndex
CREATE INDEX "FileLink_organizationId_subjectType_subjectId_idx" ON "FileLink"("organizationId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_recipientMemberId_status_idx" ON "Notification"("organizationId", "recipientMemberId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organizationId_dedupeKey_key" ON "Notification"("organizationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_contractSignatoryMemberId_fkey" FOREIGN KEY ("contractSignatoryMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrgModule" ADD CONSTRAINT "OrgModule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "OrgModule" ADD CONSTRAINT "OrgModule_changedByPlatformAdminId_fkey" FOREIGN KEY ("changedByPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_grantedByPlatformAdminId_fkey" FOREIGN KEY ("grantedByPlatformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BreakGlassSession" ADD CONSTRAINT "BreakGlassSession_platformAdminId_fkey" FOREIGN KEY ("platformAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "BreakGlassSession" ADD CONSTRAINT "BreakGlassSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CommandLog" ADD CONSTRAINT "CommandLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileObject" ADD CONSTRAINT "FileObject_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileLink" ADD CONSTRAINT "FileLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "FileLink" ADD CONSTRAINT "FileLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileObject"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientMemberId_fkey" FOREIGN KEY ("recipientMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ============================================================================
-- Hand-written SQL (spec §6.3). Appended before the migration was first applied.
-- ============================================================================

-- 1) Append-only tables (INV-EVT-01). The same function guards BudgetLedgerEntry (S3-01) and EventSeal (S5).
CREATE OR REPLACE FUNCTION bcs_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON "Event"
  FOR EACH ROW EXECUTE FUNCTION bcs_forbid_mutation();
-- TRUNCATE does not fire row triggers: only the migrator role may truncate, in local/test only.

-- 2) Privileges of the runtime role. Kept in migrations (not only in docker initdb) because db:reset drops
--    and recreates the schema, which also drops schema-scoped default privileges.
GRANT USAGE ON SCHEMA public TO bcs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bcs_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bcs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bcs_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bcs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bcs_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO bcs_app;
-- Prisma's own bookkeeping table exists in the real database but not in the shadow database
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON "_prisma_migrations" FROM bcs_app';
  END IF;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE ON "Event" FROM bcs_app;
GRANT SELECT, INSERT ON "Event" TO bcs_app;

-- CommandLog is written once per command and purged only by the migrator after 90 days (spec §6.2)
REVOKE UPDATE, DELETE, TRUNCATE ON "CommandLog" FROM bcs_app;
GRANT SELECT, INSERT ON "CommandLog" TO bcs_app;
