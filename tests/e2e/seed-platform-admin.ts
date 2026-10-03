import { deriveSeedBackupCodes, deriveSeedTotpSecret } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { E2E_DB } from '../support/e2e-env'
import { E2E_PLATFORM_ADMIN } from './platform-admin'

// Run by tests/e2e/prepare-db.ts against bcs_e2e only (see platform-admin.ts). Safe to run again.
const password = process.env.SEED_DEV_PASSWORD
const totpKey = process.env.SEED_TOTP_KEY
if (!password || !totpKey) throw new Error('SEED_DEV_PASSWORD and SEED_TOTP_KEY are needed for the e2e platform admin')
if (new URL(process.env.DATABASE_URL ?? 'postgresql://x/none').pathname !== `/${E2E_DB}`) throw new Error('the e2e platform admin is created in the e2e database only')

const userId = await upsertUserWithPassword({ email: E2E_PLATFORM_ADMIN.email, name: E2E_PLATFORM_ADMIN.displayName, password })
const code = E2E_PLATFORM_ADMIN.code
await enableTotpWithSecret(userId, deriveSeedTotpSecret(totpKey, code), deriveSeedBackupCodes(totpKey, code))
await prisma.platformAdmin.upsert({
  where: { userId },
  create: { userId, displayName: E2E_PLATFORM_ADMIN.displayName },
  update: { active: true, displayName: E2E_PLATFORM_ADMIN.displayName },
})
await prisma.$disconnect()
console.log('e2e platform admin ready')
