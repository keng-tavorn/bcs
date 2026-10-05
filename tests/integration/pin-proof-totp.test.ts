import { beforeAll, describe, expect, it } from 'vitest'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { confirmIdentityForPin, getOwnPinStatus } from '@/server/services/self/pin'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-05 · FR-AUTH-005 AC1: before setting a PIN the member proves who they are again — with the password, or with the
// code of an authenticator app that is confirmed the way Better Auth's own sign-in counts one: two-step sign-in on for the
// identity, and the app's setup confirmed with a code (TwoFactor.verified true, or null on rows made before the column).
// The code of any other authenticator row proves nothing, even when it is right: no proof, the answer of a member who has
// no authenticator, and the screens do not offer it (src/server/auth/step-up.ts, src/server/auth/proof-methods.ts). Real
// Postgres (BCS_TEST_DB), an organization from the §7.4 fixtures; the codes are of real time, as the check reads them.

const NOW = new Date('2026-10-05T03:00:00Z')
const PASSWORD = 'pin-totp-password-0001'

let org: DoaOrg
const ctx = (code: string) => org.ctxOf(code, NOW)

/** The member's sign-in identity with the test password and an authenticator set up with `secret`, as an app confirms it */
async function withAuthenticator(code: string, secret: string): Promise<string> {
  const member = await prisma.member.findUniqueOrThrow({ where: { id: org.member[code]! } })
  const userId = await upsertUserWithPassword({ email: member.email, name: member.displayNameTh, password: PASSWORD })
  await enableTotpWithSecret(userId, secret, [])
  await prisma.member.update({ where: { id: member.id }, data: { userId } })
  return userId
}

const proofMethods = async (code: string) => {
  const status = await getOwnPinStatus(ctx(code))
  if (!status.ok) throw new Error(`no status: ${status.error.code}`)
  return status.data.proofMethods
}

const NOT_AVAILABLE = { ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'method', reason: 'NOT_AVAILABLE' } } }

beforeAll(async () => {
  org = await createDoaOrg()
})

describe('[FR-AUTH-005/AC1] only a confirmed authenticator proves who the member is before a PIN is set', () => {
  it('a confirmed app gives a proof with its right code, as a row made before Better Auth kept `verified` does', async () => {
    const secret = 'C'.repeat(32)
    await withAuthenticator('auditor', secret)
    expect(await confirmIdentityForPin(ctx('auditor'), { method: 'TOTP', code: totp(secret) })).toMatchObject({ ok: true, data: { method: 'TOTP' } })

    const older = 'D'.repeat(32)
    const userId = await withAuthenticator('dm_fin', older)
    await prisma.twoFactor.updateMany({ where: { userId }, data: { verified: null } })
    expect(await proofMethods('dm_fin')).toEqual(['PASSWORD', 'TOTP'])
    expect(await confirmIdentityForPin(ctx('dm_fin'), { method: 'TOTP', code: totp(older) })).toMatchObject({ ok: true, data: { method: 'TOTP' } })
  })

  it('a setup started and never confirmed with a code gives no proof, though its code is right', async () => {
    const secret = 'F'.repeat(32)
    const userId = await withAuthenticator('fin_officer', secret)
    // Better Auth's enable before verify: the row is there, unconfirmed, and two-step sign-in is not on yet
    await prisma.twoFactor.updateMany({ where: { userId }, data: { verified: false } })
    await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } })
    expect(await proofMethods('fin_officer')).toEqual(['PASSWORD'])
    expect(await confirmIdentityForPin(ctx('fin_officer'), { method: 'TOTP', code: totp(secret) })).toMatchObject(NOT_AVAILABLE)
    // The password still proves who they are
    expect(await confirmIdentityForPin(ctx('fin_officer'), { method: 'PASSWORD', password: PASSWORD })).toMatchObject({ ok: true, data: { method: 'PASSWORD' } })
  })

  it('an unconfirmed setup gives none either while two-step sign-in is on, nor does a confirmed app once two-step sign-in is off', async () => {
    const unconfirmed = 'G'.repeat(32)
    const a = await withAuthenticator('req_con', unconfirmed)
    await prisma.twoFactor.updateMany({ where: { userId: a }, data: { verified: false } })
    expect(await proofMethods('req_con')).toEqual(['PASSWORD'])
    expect(await confirmIdentityForPin(ctx('req_con'), { method: 'TOTP', code: totp(unconfirmed) })).toMatchObject(NOT_AVAILABLE)

    const switchedOff = 'H'.repeat(32)
    const b = await withAuthenticator('dm_it', switchedOff)
    await prisma.user.update({ where: { id: b }, data: { twoFactorEnabled: false } })
    expect(await proofMethods('dm_it')).toEqual(['PASSWORD'])
    expect(await confirmIdentityForPin(ctx('dm_it'), { method: 'TOTP', code: totp(switchedOff) })).toMatchObject(NOT_AVAILABLE)
  })

  it('a refused code is counted and recorded like a failed sign-in, never with the code', async () => {
    const secret = 'J'.repeat(32)
    const userId = await withAuthenticator('asst_con', secret)
    await prisma.twoFactor.updateMany({ where: { userId }, data: { verified: false } })
    const member = await prisma.member.findUniqueOrThrow({ where: { id: org.member.asst_con! } })
    const since = new Date()
    const code = totp(secret)
    expect(await confirmIdentityForPin(ctx('asst_con'), { method: 'TOTP', code })).toMatchObject(NOT_AVAILABLE)
    const failed = await prisma.event.findMany({ where: { type: 'auth.login_failed', aggregateId: member.id, occurredAt: { gte: since } } })
    expect(failed.map((e) => e.data)).toEqual([expect.objectContaining({ step: 'two_factor', memberKnown: true })])
    expect(JSON.stringify(failed.map((e) => e.data))).not.toContain(code)
    expect(await prisma.authAttempt.count({ where: { email: member.email, success: false, createdAt: { gte: since } } })).toBe(1)
  })
})
