// S17-15 (FR-PLT-301 AC3 AC4, FR-AUTH-005 AC2, BR-AUTH-09 to BR-AUTH-11, ADR-166): passkeys as a proof of step-up,
// checked by BCS with @simplewebauthn/server against Postgres. A software authenticator (tests/support/soft-authenticator.ts)
// makes real ES256 credentials and assertions, each with the one fact a test means to break. Adding a passkey takes a
// fresh proof of who the member is; an assertion earns the PIN's grant only from this environment's origin and RP ID,
// with the member's own credential, a live unused challenge for this document, a valid signature, user verification and
// a counter that moved on; every subject that needs a step-up takes it; a reset of the identity or a deactivation
// revokes the passkeys; and no endpoint of Better Auth's passkey plugin is open.
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { STEP_UP_SUBJECT_TYPES } from '@/server/auth/step-up'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { grantStepUpByPasskey, relyingParty, stepUpOptions } from '@/server/auth/passkey'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { consumeStepUp, DECISION_STEP_UP_METHODS, policyStepUpMethods } from '@/server/auth/step-up'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { deactivateMember, resetMemberTwoFactor } from '@/server/services/members'
import { addOwnPasskey, listOwnPasskeys, newPasskeyOptions, removeOwnPasskey } from '@/server/services/self/passkeys'
import { confirmIdentityForPin } from '@/server/services/self/pin'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { assertionResponse, registrationResponse, softAuthenticator, type SoftAuthenticator } from '../support/soft-authenticator'

const PASSWORD = 'passkey-password-123456'
const NOW = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
const rp = () => relyingParty()

/** The member gets a password, so they can prove who they are (confirmIdentityForPin) */
async function withPassword(o: DoaOrg, code: string): Promise<void> {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: o.member[code]! } })
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: PASSWORD })
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
}

const proofOf = async (o: DoaOrg, code: string) => ok(await confirmIdentityForPin(o.ctxOf(code, NOW), { method: 'PASSWORD', password: PASSWORD })).proofToken

/** Adds a passkey of this authenticator for the member, as /settings/pin does */
async function addPasskey(o: DoaOrg, code: string, authenticator: SoftAuthenticator, uv = true): Promise<ReturnType<typeof addOwnPasskey>> {
  const proofToken = await proofOf(o, code)
  const { options } = ok(await newPasskeyOptions(o.ctxOf(code, NOW), { proofToken })) as { options: { challenge: string; rp: { id: string } } }
  const response = registrationResponse(authenticator, { challenge: options.challenge, origin: rp().origin, rpID: options.rp.id, uv })
  return addOwnPasskey(o.ctxOf(code, NOW), { proofToken, response }, key())
}

/** A step-up challenge for one document, answered by this authenticator */
async function assertion(o: DoaOrg, code: string, authenticator: SoftAuthenticator, subject: { subjectType: string; subjectId: string }, change: { uv?: boolean; origin?: string; rpID?: string; tamper?: boolean } = {}) {
  const asked = await stepUpOptions({ organizationId: o.organizationId, memberId: o.member[code]!, ...subject })
  if (!asked.ok) throw new Error(asked.reason)
  return assertionResponse(authenticator, { challenge: asked.options.challenge, origin: change.origin ?? rp().origin, rpID: change.rpID ?? rp().rpID, ...(change.uv === false ? { uv: false } : {}), ...(change.tamper ? { tamper: true } : {}) })
}

const grant = (o: DoaOrg, code: string, subject: { subjectType: string; subjectId: string }, response: unknown, at: Date = new Date()) =>
  grantStepUpByPasskey({ organizationId: o.organizationId, memberId: o.member[code]!, ...subject, response }, at, { sender: null })

const request = () => ({ subjectType: 'REQUEST', subjectId: randomUUID() })

/** An organization whose admin may reset and deactivate members */
async function orgWithAdmin(): Promise<DoaOrg> {
  const o = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: o.organizationId, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  return o
}

beforeAll(async () => {
  org = await createDoaOrg()
  for (const code of ['dm_con', 'req_con', 'coo']) await withPassword(org, code)
})

describe('[FR-PLT-301/AC4] [FR-AUTH-005/AC6] adding a passkey takes a fresh proof of who the member is (BR-AUTH-10)', () => {
  it('without the proof: STEP_UP_REQUIRED {reason: IDENTITY_PROOF}, for the options and for the passkey itself', async () => {
    const ctx = org.ctxOf('dm_con', NOW)
    expect(await newPasskeyOptions(ctx, {})).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { reason: 'IDENTITY_PROOF' } } })
    expect(await newPasskeyOptions(ctx, { proofToken: 'pin1.PASSWORD.0.x.y' })).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { reason: 'IDENTITY_PROOF' } } })
    const authenticator = softAuthenticator()
    const response = registrationResponse(authenticator, { challenge: 'Y2hhbGxlbmdl', origin: rp().origin, rpID: rp().rpID })
    expect(await addOwnPasskey(ctx, { proofToken: 'pin1.PASSWORD.0.x.y', response }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { reason: 'IDENTITY_PROOF' } } })
    expect(await prisma.memberPasskey.count({ where: { memberId: org.member.dm_con! } })).toBe(0)
  })

  it('with it: the passkey is kept with its event and an e-mail to the owner, and listed; removing it needs nothing more', async () => {
    const added = ok(await addPasskey(org, 'req_con', softAuthenticator()))
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'auth.passkey_added', aggregateId: org.member.req_con! }, orderBy: { occurredAt: 'desc' } })).toMatchObject({ data: { passkeyId: added.passkeyId, proof: 'PASSWORD' } })
    expect(await prisma.notification.findFirst({ where: { recipientMemberId: org.member.req_con!, templateKey: 'security.notice', data: { path: ['kind'], equals: 'PASSKEY_ADDED' } } })).not.toBeNull()
    expect(ok(await listOwnPasskeys(org.ctxOf('req_con', NOW))).map((p) => p.id)).toEqual([added.passkeyId])
    // Another member neither sees nor removes it
    expect(ok(await listOwnPasskeys(org.ctxOf('dm_con', NOW))).map((p) => p.id)).not.toContain(added.passkeyId)
    expect(await removeOwnPasskey(org.ctxOf('dm_con', NOW), { passkeyId: added.passkeyId }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    ok(await removeOwnPasskey(org.ctxOf('req_con', NOW), { passkeyId: added.passkeyId }, key()))
    expect(await prisma.memberPasskey.findUniqueOrThrow({ where: { id: added.passkeyId } })).toMatchObject({ revokeReason: 'USER' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'auth.passkey_removed', aggregateId: org.member.req_con! } })).toMatchObject({ data: { passkeyId: added.passkeyId, by: 'SELF' } })
  })

  it('refused: no user verification, another origin, a challenge used already, the same passkey twice', async () => {
    expect(await addPasskey(org, 'coo', softAuthenticator(), false)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'passkey', reason: 'UV_REQUIRED' } } })
    const proofToken = await proofOf(org, 'coo')
    const { options } = ok(await newPasskeyOptions(org.ctxOf('coo', NOW), { proofToken })) as { options: { challenge: string } }
    const authenticator = softAuthenticator()
    const elsewhere = registrationResponse(authenticator, { challenge: options.challenge, origin: 'https://evil.example.com', rpID: rp().rpID })
    expect(await addOwnPasskey(org.ctxOf('coo', NOW), { proofToken, response: elsewhere }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ORIGIN_MISMATCH' } } })
    const response = registrationResponse(authenticator, { challenge: options.challenge, origin: rp().origin, rpID: rp().rpID })
    ok(await addOwnPasskey(org.ctxOf('coo', NOW), { proofToken, response }, key()))
    // The same answer again: its challenge is used
    expect(await addOwnPasskey(org.ctxOf('coo', NOW), { proofToken, response }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CHALLENGE' } } })
    // The same authenticator with a new challenge: added already
    expect(await addPasskey(org, 'coo', authenticator)).toMatchObject({ ok: false, error: { details: { reason: 'DUPLICATE' } } })
  })

  it('Better Auth opens no passkey endpoint under /api/auth/* (OQ-167: the plugin is not installed)', async () => {
    const base = getEnv().BETTER_AUTH_URL
    for (const path of ['/api/auth/passkey/generate-register-options', '/api/auth/passkey/verify-registration', '/api/auth/passkey/generate-authenticate-options', '/api/auth/sign-in/passkey']) {
      const res = await auth.handler(new Request(`${base}${path}`, { method: path.includes('generate') ? 'GET' : 'POST', headers: { origin: getEnv().APP_URL, 'content-type': 'application/json' }, body: path.includes('generate') ? null : '{}' }))
      expect(res.status, path).toBe(404)
    }
  })
})

describe('[FR-PLT-301/AC3] [FR-AUTH-005/AC2] [FR-AUTH-005/AC6] a passkey earns the PIN\'s grant (BR-AUTH-09)', () => {
  let authenticator: SoftAuthenticator
  beforeAll(async () => {
    authenticator = softAuthenticator(1)
    ok(await addPasskey(org, 'dm_con', authenticator))
  })

  it('one document, 5 minutes, used once, by every deciding command; the counter is kept', async () => {
    const subject = request()
    authenticator.counter = 2
    const granted = await grant(org, 'dm_con', subject, await assertion(org, 'dm_con', authenticator, subject))
    expect(granted).toMatchObject({ ok: true, method: 'PASSKEY' })
    if (!granted.ok) throw new Error('no grant')
    expect(granted.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(5 * 60_000)
    expect(await prisma.memberPasskey.findFirstOrThrow({ where: { credentialId: authenticator.credentialId } })).toMatchObject({ signCount: 2n })
    const used = await forTenant(org.organizationId).$transaction((tx) => consumeStepUp(tx, { memberId: org.member.dm_con!, ...subject, methods: DECISION_STEP_UP_METHODS }, new Date()))
    expect(used).toBe(granted.grantId)
    const again = await forTenant(org.organizationId).$transaction((tx) => consumeStepUp(tx, { memberId: org.member.dm_con!, ...subject, methods: DECISION_STEP_UP_METHODS }, new Date()))
    expect(again).toBeNull()
  })

  it('every subject that needs a step-up takes it, policy subjects included; the PIN still does', async () => {
    expect(DECISION_STEP_UP_METHODS).toEqual(['PIN', 'PASSKEY'])
    expect(policyStepUpMethods('APP')).toEqual(['PIN', 'PASSKEY'])
    for (const subjectType of STEP_UP_SUBJECT_TYPES) {
      const subject = { subjectType, subjectId: randomUUID() }
      authenticator.counter += 1
      const granted = await grant(org, 'dm_con', subject, await assertion(org, 'dm_con', authenticator, subject))
      expect(granted, subjectType).toMatchObject({ ok: true, method: 'PASSKEY' })
      const used = await forTenant(org.organizationId).$transaction((tx) => consumeStepUp(tx, { memberId: org.member.dm_con!, ...subject, methods: policyStepUpMethods() }, new Date()))
      expect(used, subjectType).not.toBeNull()
    }
  })

  it('refused, one fact at a time: no UV, another origin or RP ID, a broken signature, another document\'s or an old challenge, used twice', async () => {
    const subject = request()
    const refusal = async (response: unknown, at?: Date) => {
      const r = await grant(org, 'dm_con', subject, response, at)
      return r.ok ? 'GRANT' : r.refusal
    }
    authenticator.counter += 1
    expect(await refusal(await assertion(org, 'dm_con', authenticator, subject, { uv: false }))).toBe('UV_REQUIRED')
    expect(await refusal(await assertion(org, 'dm_con', authenticator, subject, { origin: 'https://evil.example.com' }))).toBe('ORIGIN_MISMATCH')
    expect(await refusal(await assertion(org, 'dm_con', authenticator, subject, { rpID: 'evil.example.com' }))).toBe('ORIGIN_MISMATCH')
    expect(await refusal(await assertion(org, 'dm_con', authenticator, subject, { tamper: true }))).toBe('SIGNATURE')
    expect(await refusal(await assertion(org, 'dm_con', authenticator, request()))).toBe('CHALLENGE_EXPIRED')
    expect(await refusal(await assertion(org, 'dm_con', authenticator, subject), new Date(Date.now() + 6 * 60_000))).toBe('CHALLENGE_EXPIRED')
    expect(await refusal({ id: 'x' })).toBe('MALFORMED')
    const good = await assertion(org, 'dm_con', authenticator, subject)
    expect(await refusal(good)).toBe('GRANT')
    expect(await refusal(good)).toBe('CHALLENGE_USED')
  })

  it("another member's passkey, and a counter that went back (its owner is told)", async () => {
    const subject = request()
    // dm_con's credential answering a challenge issued to req_con
    const asked = await stepUpOptions({ organizationId: org.organizationId, memberId: org.member.dm_con!, ...subject })
    if (!asked.ok) throw new Error(asked.reason)
    const theirs = assertionResponse(authenticator, { challenge: asked.options.challenge, origin: rp().origin, rpID: rp().rpID })
    const byOther = await grant(org, 'req_con', subject, theirs)
    expect(byOther).toMatchObject({ ok: false, refusal: 'NOT_OWNER' })
    authenticator.counter = 1
    expect(await grant(org, 'dm_con', subject, await assertion(org, 'dm_con', authenticator, subject))).toMatchObject({ ok: false, refusal: 'SIGN_COUNT' })
    expect(await prisma.notification.findFirst({ where: { recipientMemberId: org.member.dm_con!, data: { path: ['kind'], equals: 'PASSKEY_SIGN_COUNT' } } })).not.toBeNull()
    authenticator.counter = 1000
  })

  it('a member without a passkey gets no options: the page offers the PIN', async () => {
    expect(await stepUpOptions({ organizationId: org.organizationId, memberId: org.member.req_con!, ...request() })).toEqual({ ok: false, reason: 'NO_PASSKEY' })
  })
})

describe('[FR-PLT-301/AC4] a reset of the identity or a deactivation revokes the passkeys (BR-AUTH-11)', () => {
  it('reset: every passkey of the member stops counting, with auth.passkey_removed by IDENTITY_RESET', async () => {
    const o = await orgWithAdmin()
    await withPassword(o, 'req_con')
    const authenticator = softAuthenticator()
    const { passkeyId } = ok(await addPasskey(o, 'req_con', authenticator))
    ok(await resetMemberTwoFactor(o.ctxOf('admin', NOW), { memberId: o.member.req_con!, reason: 'ทดสอบรีเซ็ต' }, key()))
    expect(await prisma.memberPasskey.findUniqueOrThrow({ where: { id: passkeyId } })).toMatchObject({ revokeReason: 'IDENTITY_RESET' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'auth.passkey_removed', aggregateId: o.member.req_con! } })).toMatchObject({ data: { passkeyId, by: 'IDENTITY_RESET' } })
    const subject = request()
    expect(await stepUpOptions({ organizationId: o.organizationId, memberId: o.member.req_con!, ...subject })).toEqual({ ok: false, reason: 'NO_PASSKEY' })
  })

  it('deactivation: revoked in the same transaction, and a deactivated member\'s passkey earns nothing', async () => {
    const o = await orgWithAdmin()
    await withPassword(o, 'req_con')
    const authenticator = softAuthenticator()
    const { passkeyId } = ok(await addPasskey(o, 'req_con', authenticator))
    const subject = request()
    const before = await assertion(o, 'req_con', authenticator, subject)
    ok(await deactivateMember(o.ctxOf('admin', NOW), { memberId: o.member.req_con!, reason: 'ทดสอบปิดใช้งาน' }, key()))
    expect(await prisma.memberPasskey.findUniqueOrThrow({ where: { id: passkeyId } })).toMatchObject({ revokeReason: 'DEACTIVATED' })
    expect(await grant(o, 'req_con', subject, before)).toMatchObject({ ok: false, refusal: 'NOT_OWNER' })
  })
})
