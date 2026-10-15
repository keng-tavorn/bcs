-- CreateEnum
CREATE TYPE "ChatIntakeStatus" AS ENUM ('OPEN', 'DRAFTED', 'DISMISSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ChatIntakeItemKind" AS ENUM ('TEXT', 'IMAGE');

-- CreateEnum
CREATE TYPE "ChatIntakeFetchStatus" AS ENUM ('NOT_NEEDED', 'PENDING', 'STORED', 'FAILED');

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('ANDROID', 'IOS');

-- CreateEnum
CREATE TYPE "PushDeviceRevokeReason" AS ENUM ('LOGOUT', 'USER', 'DEACTIVATED', 'UNREGISTERED', 'REPLACED');

-- AlterEnum
ALTER TYPE "Channel" ADD VALUE 'APP';

-- AlterEnum
ALTER TYPE "NotificationChannel" ADD VALUE 'PUSH';

-- AlterEnum
ALTER TYPE "StepUpMethod" ADD VALUE 'PASSKEY';

-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "offlineCapturedAt" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "ChatIntake" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "status" "ChatIntakeStatus" NOT NULL DEFAULT 'OPEN',
    "text" TEXT,
    "textTruncated" BOOLEAN NOT NULL DEFAULT false,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastMessageAt" TIMESTAMPTZ(6) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "linkSentAt" TIMESTAMPTZ(6),
    "requestTypeId" UUID,
    "requestId" UUID,
    "draftedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "purgedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ChatIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatIntakeItem" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "intakeId" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "ChatIntakeItemKind" NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "fileId" UUID,
    "fetchStatus" "ChatIntakeFetchStatus" NOT NULL DEFAULT 'NOT_NEEDED',
    "fetchError" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ChatIntakeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineInboundMessage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lineWebhookEventId" UUID NOT NULL,
    "lineMessageId" TEXT NOT NULL,
    "kind" "ChatIntakeItemKind" NOT NULL,
    "text" TEXT,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LineInboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDevice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "registeredAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "revokeReason" "PushDeviceRevokeReason",
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PushDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineRichMenuVariant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "channelConfigId" UUID NOT NULL,
    "variantKey" TEXT NOT NULL,
    "richMenuId" TEXT NOT NULL,
    "madeAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LineRichMenuVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatIntake_organizationId_memberId_status_lastMessageAt_idx" ON "ChatIntake"("organizationId", "memberId", "status", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChatIntake_organizationId_id_key" ON "ChatIntake"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChatIntake_organizationId_requestId_key" ON "ChatIntake"("organizationId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatIntakeItem_organizationId_id_key" ON "ChatIntakeItem"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChatIntakeItem_organizationId_intakeId_seq_key" ON "ChatIntakeItem"("organizationId", "intakeId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ChatIntakeItem_organizationId_lineMessageId_key" ON "ChatIntakeItem"("organizationId", "lineMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "LineInboundMessage_organizationId_id_key" ON "LineInboundMessage"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LineInboundMessage_organizationId_lineWebhookEventId_key" ON "LineInboundMessage"("organizationId", "lineWebhookEventId");

-- CreateIndex
CREATE INDEX "PushDevice_organizationId_memberId_revokedAt_idx" ON "PushDevice"("organizationId", "memberId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_organizationId_id_key" ON "PushDevice"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PushDevice_token_in_use" ON "PushDevice"("organizationId", "tokenHash") WHERE ("revokedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "LineRichMenuVariant_organizationId_id_key" ON "LineRichMenuVariant"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LineRichMenuVariant_organizationId_variantKey_key" ON "LineRichMenuVariant"("organizationId", "variantKey");

-- AddForeignKey
ALTER TABLE "ChatIntake" ADD CONSTRAINT "ChatIntake_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatIntake" ADD CONSTRAINT "ChatIntake_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatIntake" ADD CONSTRAINT "ChatIntake_organizationId_requestTypeId_fkey" FOREIGN KEY ("organizationId", "requestTypeId") REFERENCES "RequestType"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatIntake" ADD CONSTRAINT "ChatIntake_organizationId_requestId_fkey" FOREIGN KEY ("organizationId", "requestId") REFERENCES "Request"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatIntakeItem" ADD CONSTRAINT "ChatIntakeItem_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatIntakeItem" ADD CONSTRAINT "ChatIntakeItem_organizationId_intakeId_fkey" FOREIGN KEY ("organizationId", "intakeId") REFERENCES "ChatIntake"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChatIntakeItem" ADD CONSTRAINT "ChatIntakeItem_organizationId_fileId_fkey" FOREIGN KEY ("organizationId", "fileId") REFERENCES "FileObject"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineInboundMessage" ADD CONSTRAINT "LineInboundMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineInboundMessage" ADD CONSTRAINT "LineInboundMessage_organizationId_lineWebhookEventId_fkey" FOREIGN KEY ("organizationId", "lineWebhookEventId") REFERENCES "LineWebhookEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PushDevice" ADD CONSTRAINT "PushDevice_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineRichMenuVariant" ADD CONSTRAINT "LineRichMenuVariant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineRichMenuVariant" ADD CONSTRAINT "LineRichMenuVariant_organizationId_channelConfigId_fkey" FOREIGN KEY ("organizationId", "channelConfigId") REFERENCES "LineChannelConfig"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ===== spec §6.3 for S17 (S17-01, docs/sub-specs/S17.md "Entity และ migration") =====

-- The text counts code points as settings.chatIntake.maxTextChars does (BR-LINE-10); at most 10 images per draft
ALTER TABLE "ChatIntake" ADD CONSTRAINT chat_intake_text_length CHECK ("text" IS NULL OR char_length("text") <= 2000);
ALTER TABLE "ChatIntake" ADD CONSTRAINT chat_intake_image_count CHECK ("imageCount" BETWEEN 0 AND 10);
ALTER TABLE "ChatIntake" ADD CONSTRAINT chat_intake_message_count CHECK ("messageCount" >= 0);
-- A draft names its request, and only a draft does (state machine of ChatIntake, BR-LINE-12)
ALTER TABLE "ChatIntake" ADD CONSTRAINT chat_intake_drafted_request CHECK (("status" = 'DRAFTED') = ("requestId" IS NOT NULL));
ALTER TABLE "ChatIntakeItem" ADD CONSTRAINT chat_intake_item_seq CHECK ("seq" >= 1);
-- A text message fetches nothing; an image names its file exactly when it is stored (BR-LINE-14)
ALTER TABLE "ChatIntakeItem" ADD CONSTRAINT chat_intake_item_fetch CHECK (
  ("kind" = 'TEXT' AND "fetchStatus" = 'NOT_NEEDED' AND "fileId" IS NULL)
  OR ("kind" = 'IMAGE' AND "fetchStatus" <> 'NOT_NEEDED' AND ("fetchStatus" = 'STORED') = ("fileId" IS NOT NULL)));
-- Only a text message has text waiting (BR-LINE-11)
ALTER TABLE "LineInboundMessage" ADD CONSTRAINT line_inbound_text CHECK ("kind" = 'TEXT' OR "text" IS NULL);
-- The token is kept encrypted; its sha256 is 64 lower-case hex (BR-APP-12)
ALTER TABLE "PushDevice" ADD CONSTRAINT push_device_token_hash CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "PushDevice" ADD CONSTRAINT push_device_label_length CHECK ("deviceLabel" IS NULL OR char_length("deviceLabel") <= 60);
ALTER TABLE "PushDevice" ADD CONSTRAINT push_device_revoked CHECK (("revokedAt" IS NULL) = ("revokeReason" IS NULL));
