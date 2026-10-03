import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { REDACTED, redactDeep, scrubText } from '@/lib/logger'
import { totp } from '@/lib/totp'
import { checkPinChangeProof, PIN_PROOF_TTL_MS, signPinChangeProof, verifyPin } from '@/server/auth/pin'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { seedDevPins } from '@/server/seed/pins'
import { confirmIdentityForPin, getOwnPinStatus, setOwnPin } from '@/server/services/self/pin'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S5-05, FR-AUTH-005 AC1 and NEW-30: a member sets or changes their own transaction PIN (capability self.pin, OWN) right
// after proving who they are again with the password or the authenticator code (a proof good for 5 minutes on the
// security clock); the PIN is six digits that are not easy to guess, stored as argon2id; auth.pin_set records it without
// the PIN or its hash. Nobody sets another member's PIN. The demo seed gives SEED_DEV_PIN to the approvers.
// Real Postgres (BCS_TEST_DB), an organization from the §7.4 fixtures.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PASSWORD = 'pin-test-password-0001'
const VP_SECRET = 'V'.repeat(32)

let org: DoaOrg
const member = (code: string) => org.member[code]!

/** A sign-in identity with the test password (and an authenticator when a secret is given), linked to the member */
async function identity(target: DoaOrg, code: string, totpSecret?: string) {
  const m = await prisma.member.findUniqueOrThrow({ where: { id: target.member[code]! } })
  const userId = await upsertUserWithPassword({ email: m.email, name: m.displayNameTh, password: PASSWORD })
  if (totpSecret) await enableTotpWithSecret(userId, totpSecret, [])
  await prisma.member.update({ where: { id: m.id }, data: { userId } })
}

async function proofOf(code: string, how: { method: 'PASSWORD'; password: string } | { method: 'TOTP'; code: string } = { method: 'PASSWORD', password: PASSWORD }) {
  const proved = await confirmIdentityForPin(org.ctxOf(code, NOW), how)
  if (!proved.ok) throw new Error(`proof refused: ${proved.error.code}`)
  return proved.data.proofToken
}

/** JSON of database rows (Event.seq is a bigint) */
const text = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))

const pinRow = (code: string) => prisma.member.findUniqueOrThrow({ where: { id: member(code) }, select: { transactionPinHash: true, pinFailedCount: true, pinLockedUntil: true } })
const pinEvents = (code: string) => prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'auth.pin_set', aggregateId: member(code) }, orderBy: { seq: 'asc' } })

beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: member('admin'), role: 'ORG_ADMIN', grantedAt: NOW } })
  await identity(org, 'vp_ops', VP_SECRET)
  for (const code of ['dm_fin', 'dm_con', 'ceo', 'admin', 'asst_con', 'dm_it']) await identity(org, code)
})

describe('[FR-AUTH-005/AC1] the member sets a six-digit PIN, stored as argon2id and recorded without it (NEW-30)', () => {
  it('stores an argon2id hash under the pepper key, never the PIN, and records auth.pin_set without the PIN or the hash', async () => {
    const set = await setOwnPin(org.ctxOf('vp_ops', NOW), { memberId: member('vp_ops'), pin: '739164', proofToken: await proofOf('vp_ops') }, key())
    expect(set).toEqual({ ok: true, data: { memberId: member('vp_ops'), replaced: false } })

    const row = await pinRow('vp_ops')
    expect(row.transactionPinHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1,keyid=[0-9a-f]{8}\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    expect(row.transactionPinHash).not.toContain('739164')
    expect(await verifyPin('739164', row.transactionPinHash!)).toBe(true)
    expect(await verifyPin('739165', row.transactionPinHash!)).toBe(false)
    expect(row).toMatchObject({ pinFailedCount: 0, pinLockedUntil: null })

    const [event, ...more] = await pinEvents('vp_ops')
    expect(more).toEqual([])
    expect(event).toMatchObject({ aggregateType: 'Auth', actorType: 'USER', actorMemberId: member('vp_ops'), channel: 'WEB', data: { replaced: false, proof: 'PASSWORD', unlocked: false } })
    const stored = text([event, await prisma.commandLog.findMany({ where: { organizationId: org.organizationId, commandName: 'self.set_pin' } })])
    expect(stored).not.toContain('739164')
    expect(stored).not.toContain(row.transactionPinHash!)
  })

  it('changes the PIN after a proof with the authenticator code; the old PIN no longer checks', async () => {
    const before = (await pinRow('vp_ops')).transactionPinHash!
    const proof = await proofOf('vp_ops', { method: 'TOTP', code: totp(VP_SECRET) })
    expect(await setOwnPin(org.ctxOf('vp_ops', NOW, 'LIFF'), { memberId: member('vp_ops'), pin: '480263', proofToken: proof }, key())).toEqual({ ok: true, data: { memberId: member('vp_ops'), replaced: true } })
    const after = (await pinRow('vp_ops')).transactionPinHash!
    expect(after).not.toBe(before)
    expect(await verifyPin('480263', after)).toBe(true)
    expect(await verifyPin('739164', after)).toBe(false)
    expect((await pinEvents('vp_ops')).at(-1)).toMatchObject({ channel: 'LIFF', data: { replaced: true, proof: 'TOTP', unlocked: false } })
  })

  it('hands the proof over as proofToken, which the logger redacts as a key and in JSON text, like the PIN (NFR-SEC-09)', async () => {
    const proved = await confirmIdentityForPin(org.ctxOf('admin', NOW), { method: 'PASSWORD', password: PASSWORD })
    if (!proved.ok) throw new Error('proof refused')
    expect(Object.keys(proved.data).sort()).toEqual(['expiresAt', 'method', 'proofToken'])
    expect(redactDeep(proved)).toMatchObject({ ok: true, data: { proofToken: REDACTED, method: 'PASSWORD' } })
    // The input of self.set_pin, as a log line might carry it
    const input = { memberId: member('admin'), pin: '739164', proofToken: proved.data.proofToken }
    expect(redactDeep({ input })).toMatchObject({ input: { pin: REDACTED, proofToken: REDACTED } })
    const line = scrubText(JSON.stringify({ input }))
    expect(line).not.toContain(proved.data.proofToken)
    expect(line).not.toContain('739164')
  })

  it('tells the member whether they have a PIN and how many tries are left, never the PIN or its hash', async () => {
    const status = await getOwnPinStatus(org.ctxOf('vp_ops', NOW))
    expect(status).toEqual({ ok: true, data: { hasPin: true, lockedUntil: null, attemptsLeft: 5 } })
    expect(await getOwnPinStatus(org.ctxOf('asst_con', NOW))).toEqual({ ok: true, data: { hasPin: false, lockedUntil: null, attemptsLeft: 5 } })
    // Only a signed-in member asks about their own PIN
    expect(await getOwnPinStatus(makeCtx({ organizationId: org.organizationId, actor: { type: 'SYSTEM' }, channel: 'SYSTEM', now: NOW }))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AUTH-005/AC1] a PIN that is easy to guess is refused, and nothing is stored', () => {
  it('refuses 123456, 000000, 654321, 890123, 121212, 147258, five digits and letters with their reason; the proof stays good', async () => {
    const proof = await proofOf('dm_fin')
    const cases: Array<[string, string]> = [
      ['123456', 'SEQUENCE'],
      ['000000', 'ALL_SAME'],
      ['654321', 'SEQUENCE'],
      ['890123', 'SEQUENCE'],
      ['121212', 'COMMON'],
      ['147258', 'COMMON'],
      ['12345', 'FORMAT'],
      ['abcdef', 'FORMAT'],
      [' 739164', 'FORMAT'],
    ]
    for (const [pin, reason] of cases) {
      const refused = await setOwnPin(org.ctxOf('dm_fin', NOW), { memberId: member('dm_fin'), pin, proofToken: proof }, key())
      expect(refused, pin).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'pin', reason } } })
      expect(JSON.stringify(refused)).not.toContain(pin.trim())
    }
    expect((await pinRow('dm_fin')).transactionPinHash).toBeNull()
    expect(await pinEvents('dm_fin')).toEqual([])
    // The refusals changed nothing, so the same proof still sets a good PIN
    expect(await setOwnPin(org.ctxOf('dm_fin', NOW), { memberId: member('dm_fin'), pin: '915372', proofToken: proof }, key())).toMatchObject({ ok: true })
  })
})

describe('[FR-AUTH-005/AC1] setting a PIN needs a fresh proof of who the member is (password or authenticator code)', () => {
  const subject = (code: string, currentPinHash: string | null) => ({ organizationId: org.organizationId, memberId: member(code), currentPinHash })

  it('refuses no proof, a forged one and one older than 5 minutes on the security clock; accepts one 4½ minutes old', async () => {
    const attempt = (proof: string) => setOwnPin(org.ctxOf('dm_con', NOW), { memberId: member('dm_con'), pin: '264809', proofToken: proof }, key())
    expect(await attempt('none')).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { reason: 'IDENTITY_PROOF', proof: 'MALFORMED' } } })
    expect(await attempt(`p1.PASSWORD.${Date.now()}.${'A'.repeat(22)}.${'A'.repeat(43)}`)).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { proof: 'NOT_VALID' } } })
    // The business clock of ctx does not matter: the window is real time
    const stale = signPinChangeProof(subject('dm_con', null), 'PASSWORD', new Date(Date.now() - PIN_PROOF_TTL_MS - 1000))
    expect(await attempt(stale)).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { proof: 'EXPIRED' } } })
    expect((await pinRow('dm_con')).transactionPinHash).toBeNull()
    const fresh = signPinChangeProof(subject('dm_con', null), 'PASSWORD', new Date(Date.now() - PIN_PROOF_TTL_MS + 30_000))
    expect(await attempt(fresh)).toMatchObject({ ok: true })
  })

  it('every proof carries its own random nonce, so two made at the same instant differ and both check', () => {
    const at = new Date()
    const [one, two] = [signPinChangeProof(subject('dm_it', null), 'TOTP', at), signPinChangeProof(subject('dm_it', null), 'TOTP', at)]
    expect(one).not.toBe(two)
    expect(one).toMatch(/^p1\.TOTP\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    for (const proof of [one, two]) expect(checkPinChangeProof(proof, subject('dm_it', null), at)).toEqual({ ok: true, method: 'TOTP' })
    // Bound to the PIN as it is: once the member has a PIN, a proof made before it no longer checks
    expect(checkPinChangeProof(one, subject('dm_it', '$argon2id$another'), at)).toEqual({ ok: false, reason: 'NOT_VALID' })
  })

  it('a proof sets one PIN only: after the change the same proof is refused', async () => {
    const proof = await proofOf('dm_it')
    expect(await setOwnPin(org.ctxOf('dm_it', NOW), { memberId: member('dm_it'), pin: '503817', proofToken: proof }, key())).toMatchObject({ ok: true })
    const again = await setOwnPin(org.ctxOf('dm_it', NOW), { memberId: member('dm_it'), pin: '826154', proofToken: proof }, key())
    expect(again).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { proof: 'NOT_VALID' } } })
    expect(await verifyPin('503817', (await pinRow('dm_it')).transactionPinHash!)).toBe(true)
  })

  it("refuses another member's proof", async () => {
    const ceoProof = await proofOf('ceo')
    const refused = await setOwnPin(org.ctxOf('asst_con', NOW), { memberId: member('asst_con'), pin: '371946', proofToken: ceoProof }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED', details: { proof: 'NOT_VALID' } } })
    expect((await pinRow('asst_con')).transactionPinHash).toBeNull()
  })

  it('a wrong password gives no proof and counts toward the sign-in lock (NFR-SEC-05), recorded like a sign-in; a method not set up gives none', async () => {
    const ctx = org.ctxOf('asst_con', NOW)
    const wrong = await confirmIdentityForPin(ctx, { method: 'PASSWORD', password: 'not-the-password-0001' })
    expect(wrong).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'password', reason: 'WRONG' } } })
    expect(JSON.stringify(wrong)).not.toContain('not-the-password')
    const email = (await prisma.member.findUniqueOrThrow({ where: { id: member('asst_con') } })).email
    expect(await prisma.authAttempt.count({ where: { email, success: false } })).toBe(1)
    // asst_con has no authenticator
    expect(await confirmIdentityForPin(ctx, { method: 'TOTP', code: '123456' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'method', reason: 'NOT_AVAILABLE' } } })
    // That try counted too: with three more wrong passwords the account has five failures and is locked, so even the
    // right password gets no proof until the lock ends
    for (let i = 0; i < 3; i++) await confirmIdentityForPin(ctx, { method: 'PASSWORD', password: `not-the-password-000${i + 2}` })
    expect(await confirmIdentityForPin(ctx, { method: 'PASSWORD', password: PASSWORD })).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'ACCOUNT_LOCKED', time: expect.any(String) } } })
    // Each failure is a security event of the member, as at sign-in (FR-AUTH-001 AC3), and so is the refusal while locked
    const recorded = await prisma.event.findMany({
      where: { organizationId: org.organizationId, aggregateId: member('asst_con'), type: { in: ['auth.login_failed', 'auth.login_locked'] } },
      orderBy: { seq: 'asc' },
    })
    expect(recorded.map((e) => [e.type, e.data])).toEqual([
      ['auth.login_failed', { memberKnown: true, step: 'password' }],
      ['auth.login_failed', { memberKnown: true, step: 'two_factor' }],
      ['auth.login_failed', { memberKnown: true, step: 'password' }],
      ['auth.login_failed', { memberKnown: true, step: 'password' }],
      ['auth.login_failed', { memberKnown: true, step: 'password' }],
      ['auth.login_locked', { memberKnown: true, reason: 'ACCOUNT' }],
    ])
    for (const e of recorded) expect(e).toMatchObject({ aggregateType: 'Auth', actorType: 'USER', actorMemberId: member('asst_con') })
    expect(text(recorded)).not.toContain('not-the-password')
  })

  it('refuses malformed input by field name only', async () => {
    expect(await confirmIdentityForPin(org.ctxOf('ceo', NOW), { method: 'TOTP', code: 'abc' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'code' } } })
    expect(await confirmIdentityForPin(org.ctxOf('ceo', NOW), { method: 'SMS', code: '123456' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'method' } } })
    expect(await confirmIdentityForPin(org.ctxOf('ceo', NOW), { method: 'PASSWORD', password: '' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'password' } } })
  })
})

describe("[FR-AUTH-005/AC1] nobody sets another member's PIN (self.pin is OWN only)", () => {
  it('refuses a colleague, an ORG_ADMIN, the platform and a system job; the PIN and the events stay as they were', async () => {
    const target = { memberId: member('ceo'), pin: '371946' }
    const dmProof = await proofOf('dm_con')
    expect(await setOwnPin(org.ctxOf('dm_con', NOW), { ...target, proofToken: dmProof }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const adminProof = await proofOf('admin')
    expect(await setOwnPin(org.ctxOf('admin', NOW), { ...target, proofToken: adminProof }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const ceoProof = await proofOf('ceo')
    const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: NOW })
    expect(await setOwnPin(platform, { ...target, proofToken: ceoProof }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const system = makeCtx({ organizationId: org.organizationId, actor: { type: 'SYSTEM', job: 'test' }, channel: 'SYSTEM', now: NOW })
    expect(await setOwnPin(system, { ...target, proofToken: ceoProof }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await confirmIdentityForPin(system, { method: 'PASSWORD', password: PASSWORD })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect((await pinRow('ceo')).transactionPinHash).toBeNull()
    expect(await pinEvents('ceo')).toEqual([])
    // The CEO with their own proof may
    expect(await setOwnPin(org.ctxOf('ceo', NOW), { ...target, proofToken: ceoProof }, key())).toMatchObject({ ok: true })
  })

  it('refuses a deactivated member', async () => {
    const solo = await createDoaOrg()
    await identity(solo, 'coo')
    const ctx = solo.ctxOf('coo', NOW)
    const proved = await confirmIdentityForPin(ctx, { method: 'PASSWORD', password: PASSWORD })
    if (!proved.ok) throw new Error('proof refused')
    await prisma.member.update({ where: { id: solo.member.coo! }, data: { status: 'DEACTIVATED' } })
    expect(await setOwnPin(ctx, { memberId: solo.member.coo!, pin: '371946', proofToken: proved.data.proofToken }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await confirmIdentityForPin(ctx, { method: 'PASSWORD', password: PASSWORD })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AUTH-005/AC1] the demo seed gives SEED_DEV_PIN to every member who holds a DOA position', () => {
  // DOA version 1 of the fixtures names DM, VP, COO and CEO as approvers (PROC_MGR is named by no rule)
  const APPROVERS = ['dm_con', 'dm_proc', 'dm_fin', 'dm_it', 'vp_ops', 'vp_sup', 'coo', 'ceo']
  const OTHERS = ['req_con', 'asst_con', 'receiver_con', 'proc_officer', 'fin_officer', 'auditor', 'admin', 'admin2']

  it('sets it once for the approvers, as auth.pin_set of the seed; the others get none; a second run keeps them', async () => {
    const demo = await createDoaOrg()
    expect(await seedDevPins(demo.organizationId, '739164', NOW)).toEqual({ set: APPROVERS.length, kept: 0 })
    for (const code of APPROVERS) {
      const row = await prisma.member.findUniqueOrThrow({ where: { id: demo.member[code]! }, select: { transactionPinHash: true } })
      expect(await verifyPin('739164', row.transactionPinHash!), code).toBe(true)
    }
    for (const code of OTHERS) expect((await prisma.member.findUniqueOrThrow({ where: { id: demo.member[code]! } })).transactionPinHash, code).toBeNull()
    const events = await prisma.event.findMany({ where: { organizationId: demo.organizationId, type: 'auth.pin_set' } })
    expect(events.map((e) => e.aggregateId).sort()).toEqual(APPROVERS.map((c) => demo.member[c]!).sort())
    for (const e of events) expect(e).toMatchObject({ aggregateType: 'Auth', actorType: 'SYSTEM', channel: 'SYSTEM', data: { replaced: false, proof: null, unlocked: false } })
    expect(text(events)).not.toContain('739164')

    expect(await seedDevPins(demo.organizationId, '739164', NOW)).toEqual({ set: 0, kept: APPROVERS.length })
    expect(await prisma.event.count({ where: { organizationId: demo.organizationId, type: 'auth.pin_set' } })).toBe(APPROVERS.length)
  })

  it('refuses an easy SEED_DEV_PIN without showing it, and sets nothing', async () => {
    const demo = await createDoaOrg()
    for (const pin of ['123456', '000000', '121212', '12345']) {
      const error = await seedDevPins(demo.organizationId, pin, NOW).catch((e: unknown) => e)
      expect(error, pin).toMatchObject({ name: 'SeedPinError', message: expect.stringContaining('SEED_DEV_PIN') })
      expect((error as Error).message).not.toContain(pin)
    }
    expect(await prisma.member.count({ where: { organizationId: demo.organizationId, transactionPinHash: { not: null } } })).toBe(0)
  })
})
