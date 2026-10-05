-- CreateEnum
CREATE TYPE "IdentityChannel" AS ENUM ('LINE');

-- CreateEnum
CREATE TYPE "LineWebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "ChannelIdentity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "channel" "IdentityChannel" NOT NULL,
    "providerKey" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "linkedAt" TIMESTAMPTZ(6) NOT NULL,
    "unlinkedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ChannelIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelLinkCode" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineChannelConfig" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "channelKey" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "messagingChannelId" TEXT NOT NULL,
    "channelSecretEnc" TEXT NOT NULL,
    "channelAccessTokenEnc" TEXT NOT NULL,
    "liffId" TEXT,
    "liffChannelId" TEXT,
    "richMenuLinkedId" TEXT,
    "richMenuUnlinkedId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "LineChannelConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineWebhookEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,
    "processedAt" TIMESTAMPTZ(6),
    "status" "LineWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,

    CONSTRAINT "LineWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelIdentity_organizationId_memberId_idx" ON "ChannelIdentity"("organizationId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelIdentity_organizationId_id_key" ON "ChannelIdentity"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_identity_live_account" ON "ChannelIdentity"("organizationId", "channel", "providerKey", "externalUserId") WHERE ("unlinkedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "channel_identity_live_member" ON "ChannelIdentity"("organizationId", "memberId", "channel") WHERE ("unlinkedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLinkCode_organizationId_id_key" ON "ChannelLinkCode"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelLinkCode_organizationId_codeHash_key" ON "ChannelLinkCode"("organizationId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "LineChannelConfig_organizationId_id_key" ON "LineChannelConfig"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LineChannelConfig_organizationId_key" ON "LineChannelConfig"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "LineChannelConfig_channelKey_key" ON "LineChannelConfig"("channelKey");

-- CreateIndex
CREATE INDEX "LineWebhookEvent_organizationId_status_receivedAt_idx" ON "LineWebhookEvent"("organizationId", "status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LineWebhookEvent_organizationId_id_key" ON "LineWebhookEvent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LineWebhookEvent_organizationId_webhookEventId_key" ON "LineWebhookEvent"("organizationId", "webhookEventId");

-- AddForeignKey
ALTER TABLE "ChannelIdentity" ADD CONSTRAINT "ChannelIdentity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChannelIdentity" ADD CONSTRAINT "ChannelIdentity_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChannelLinkCode" ADD CONSTRAINT "ChannelLinkCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ChannelLinkCode" ADD CONSTRAINT "ChannelLinkCode_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineChannelConfig" ADD CONSTRAINT "LineChannelConfig_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LineWebhookEvent" ADD CONSTRAINT "LineWebhookEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
