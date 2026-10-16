-- CreateEnum
CREATE TYPE "PasskeyRevokeReason" AS ENUM ('USER', 'IDENTITY_RESET', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "PasskeyChallengePurpose" AS ENUM ('REGISTER', 'STEP_UP');

-- CreateTable
CREATE TABLE "MemberPasskey" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "signCount" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[],
    "deviceLabel" TEXT,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokeReason" "PasskeyRevokeReason",
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "MemberPasskey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyChallenge" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "memberId" UUID NOT NULL,
    "purpose" "PasskeyChallengePurpose" NOT NULL,
    "challengeHash" TEXT NOT NULL,
    "subjectType" TEXT,
    "subjectId" UUID,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "usedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasskeyChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemberPasskey_organizationId_memberId_revokedAt_idx" ON "MemberPasskey"("organizationId", "memberId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPasskey_organizationId_id_key" ON "MemberPasskey"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPasskey_organizationId_credentialId_key" ON "MemberPasskey"("organizationId", "credentialId");

-- CreateIndex
CREATE INDEX "PasskeyChallenge_organizationId_expiresAt_idx" ON "PasskeyChallenge"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyChallenge_organizationId_id_key" ON "PasskeyChallenge"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyChallenge_organizationId_challengeHash_key" ON "PasskeyChallenge"("organizationId", "challengeHash");

-- AddForeignKey
ALTER TABLE "MemberPasskey" ADD CONSTRAINT "MemberPasskey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "MemberPasskey" ADD CONSTRAINT "MemberPasskey_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT "PasskeyChallenge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT "PasskeyChallenge_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "Member"("organizationId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- S17-15 (docs/sub-specs/S17.md "Entity และ migration", BR-AUTH-09 to BR-AUTH-11): what the columns may hold
-- base64url of at most 1023 bytes (Postgres regular expressions repeat at most 255 times: the length is its own test)
ALTER TABLE "MemberPasskey" ADD CONSTRAINT member_passkey_credential_id CHECK ("credentialId" ~ '^[A-Za-z0-9_-]+$' AND char_length("credentialId") <= 1366);
ALTER TABLE "MemberPasskey" ADD CONSTRAINT member_passkey_sign_count CHECK ("signCount" >= 0);
ALTER TABLE "MemberPasskey" ADD CONSTRAINT member_passkey_label_length CHECK ("deviceLabel" IS NULL OR char_length("deviceLabel") <= 60);
ALTER TABLE "MemberPasskey" ADD CONSTRAINT member_passkey_revoked CHECK (("revokedAt" IS NULL) = ("revokeReason" IS NULL));
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT passkey_challenge_hash CHECK ("challengeHash" ~ '^[0-9a-f]{64}$');
-- A step-up challenge names the document it is for; a registration names none
ALTER TABLE "PasskeyChallenge" ADD CONSTRAINT passkey_challenge_subject CHECK (
  ("purpose" = 'STEP_UP') = ("subjectType" IS NOT NULL AND "subjectId" IS NOT NULL)
  AND ("subjectType" IS NULL) = ("subjectId" IS NULL)
);
