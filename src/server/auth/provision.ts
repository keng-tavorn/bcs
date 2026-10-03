import { symmetricEncrypt } from 'better-auth/crypto'
import { newId } from '@/lib/ids'
import { systemDb } from '@/server/db/system'
import { auth } from './auth'

// Creating identities outside the HTTP sign-in flow: accepting an invitation and the demo seed.
// Uses Better Auth's own password hasher and encryption so its sign-in and TOTP checks work unchanged.

export async function findUserByEmail(email: string) {
  return systemDb.user.findUnique({ where: { email: email.trim().toLowerCase() } })
}

/**
 * Creates the identity with a credential account, or replaces the password of an existing identity and signs
 * that identity out everywhere (same effect as a password reset; used by invitation acceptance and the seed).
 */
export async function upsertUserWithPassword(p: { email: string; name: string; password: string }): Promise<string> {
  const ctx = await auth.$context
  const email = p.email.trim().toLowerCase()
  const hash = await ctx.password.hash(p.password)
  const existing = await systemDb.user.findUnique({ where: { email } })
  if (existing) {
    const account = await systemDb.account.findFirst({ where: { userId: existing.id, providerId: 'credential' } })
    await systemDb.$transaction([
      account
        ? systemDb.account.update({ where: { id: account.id }, data: { password: hash } })
        : systemDb.account.create({ data: { id: newId(), userId: existing.id, providerId: 'credential', accountId: existing.id, password: hash } }),
      systemDb.session.deleteMany({ where: { userId: existing.id } }),
    ])
    return existing.id
  }
  const id = newId()
  await systemDb.$transaction([
    systemDb.user.create({ data: { id, email, name: p.name, emailVerified: true } }),
    systemDb.account.create({ data: { id: newId(), userId: id, providerId: 'credential', accountId: id, password: hash } }),
  ])
  return id
}

/**
 * Enables TOTP with a known secret (used by the demo seed only — local/staging — so the presenter and the
 * e2e tests can produce codes). Real users enroll through Better Auth's two-factor endpoints.
 */
export async function enableTotpWithSecret(userId: string, secret: string, backupCodes: string[]): Promise<void> {
  // Same key material Better Auth uses when a user enrolls (supports secret rotation)
  const key = (await auth.$context).secretConfig
  const encryptedSecret = await symmetricEncrypt({ key, data: secret })
  const encryptedCodes = await symmetricEncrypt({ key, data: JSON.stringify(backupCodes) })
  await systemDb.$transaction([
    systemDb.twoFactor.deleteMany({ where: { userId } }),
    systemDb.twoFactor.create({ data: { id: newId(), userId, secret: encryptedSecret, backupCodes: encryptedCodes, verified: true } }),
    systemDb.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } }),
  ])
}
