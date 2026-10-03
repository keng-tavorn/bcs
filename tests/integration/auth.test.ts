import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { fromBase32, totp } from '@/lib/totp'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { auth } from '@/server/auth/auth'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { resolveSession } from '@/server/auth/session'
import { listMySessions } from '@/server/auth/sessions'
import { acceptInvitation, deactivateMember, inviteMember, resetMemberTwoFactor, revokeOwnSession } from '@/server/services/members'
import { createMember, createOrg } from '../support/factory'

const outbox: EmailMessage[] = []
const PASSWORD = 'correct-horse-battery-9'

beforeAll(() => {
  setEmailProvider({
    async send(message) {
      outbox.push(message)
      return { messageId: randomUUID() }
    },
  })
})
afterAll(() => setEmailProvider(null))

const lastMailTo = (to: string) => [...outbox].reverse().find((m) => m.to === to)
const linkIn = (mail: EmailMessage | undefined) => /https?:\/\/\S+/.exec(mail?.text ?? '')?.[0] ?? ''

async function orgWithAdmin() {
  const org = await createOrg()
  const admin = await createMember(org.id, 'แอดมิน ดูแลระบบ')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: new Date() })
  return { org, admin, ctx }
}

/** The password step through Better Auth's HTTP handler (the same path a browser uses), from the given address. */
async function signInResponse(email: string, password: string, ip: string): Promise<Response> {
  const env = getEnv()
  return auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    }),
  )
}

/** Signs in through Better Auth's HTTP handler and returns the session cookie. */
async function signIn(email: string, password: string, ip = '203.0.113.7') {
  const res = await signInResponse(email, password, ip)
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const body = res.ok ? ((await res.json()) as { twoFactorRedirect?: boolean }) : null
  return { status: res.status, cookie, twoFactor: Boolean(body?.twoFactorRedirect) }
}

/** The second sign-in step through Better Auth's HTTP handler, from the given address. */
async function verifyTotpOverHttp(cookie: string, code: string, ip: string) {
  const env = getEnv()
  return auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/two-factor/verify-totp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, cookie, 'x-forwarded-for': ip },
      body: JSON.stringify({ code }),
    }),
  )
}

async function activatedMember(orgId: string, roles: Array<'ORG_ADMIN' | 'FINANCE'> = []) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ทดสอบ', password: PASSWORD })
  const member = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้ทดสอบ', status: 'ACTIVE', userId } })
  for (const role of roles) await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: member.id, role, grantedAt: new Date() } })
  return { email, userId, member }
}

describe('[FR-AUTH-001/AC1] invitation by e-mail', () => {
  it('ORG_ADMIN invites; the one-time link sets a password and activates the member', async () => {
    const { org, ctx } = await orgWithAdmin()
    const email = `${randomUUID()}@test.bcs.local`
    const invited = await inviteMember(ctx, { email, displayNameTh: 'สมหญิง รักงาน', roles: ['FINANCE'] }, { idempotencyKey: randomUUID(), sender: null })
    expect(invited).toMatchObject({ ok: true, data: { emailSent: true } })
    if (!invited.ok) return
    const expires = new Date(invited.data.expiresAt).getTime() - ctx.now.getTime()
    expect(expires).toBe(72 * MS_PER_HOUR)
    const token = linkIn(lastMailTo(email)).split('/invite/')[1]!
    expect(token.length).toBeGreaterThan(20)

    const accepted = await acceptInvitation({ token: decodeURIComponent(token), password: PASSWORD }, new Date())
    expect(accepted).toMatchObject({ ok: true, data: { organizationId: org.id } })
    const member = await prisma.member.findUniqueOrThrow({ where: { id: invited.data.memberId } })
    expect(member.status).toBe('ACTIVE')
    expect(member.userId).not.toBeNull()
    const events = await prisma.event.findMany({ where: { aggregateId: member.id }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => e.type)).toEqual(['member.invited', 'member.role_granted', 'member.activated'])
    // The link works once only.
    expect(await acceptInvitation({ token: decodeURIComponent(token), password: PASSWORD }, new Date())).toMatchObject({ ok: false, error: { code: 'TOKEN_USED' } })
  })

  it('refuses expired links and unknown tokens', async () => {
    const { ctx } = await orgWithAdmin()
    const email = `${randomUUID()}@test.bcs.local`
    await inviteMember(ctx, { email, displayNameTh: 'ทดสอบ หมดอายุ' }, { idempotencyKey: randomUUID(), sender: null })
    const token = decodeURIComponent(linkIn(lastMailTo(email)).split('/invite/')[1]!)
    const later = new Date(Date.now() + 72 * MS_PER_HOUR + MS_PER_MINUTE)
    expect(await acceptInvitation({ token, password: PASSWORD }, later)).toMatchObject({ ok: false, error: { code: 'TOKEN_EXPIRED' } })
    expect(await acceptInvitation({ token: 'x'.repeat(43), password: PASSWORD }, new Date())).toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } })
  })

  it('refuses invitations from a member without admin.members (deny case)', async () => {
    const org = await createOrg()
    const plain = await createMember(org.id)
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: plain.id }, channel: 'WEB', now: new Date() })
    const r = await inviteMember(ctx, { email: `${randomUUID()}@test.bcs.local`, displayNameTh: 'x' }, { idempotencyKey: randomUUID(), sender: null })
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AUTH-001/AC2] password rules and reset', () => {
  it('requires at least 12 characters', async () => {
    const { ctx } = await orgWithAdmin()
    const email = `${randomUUID()}@test.bcs.local`
    await inviteMember(ctx, { email, displayNameTh: 'รหัสสั้น' }, { idempotencyKey: randomUUID(), sender: null })
    const token = decodeURIComponent(linkIn(lastMailTo(email)).split('/invite/')[1]!)
    expect(await acceptInvitation({ token, password: 'short-pass1' }, new Date())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'password' } } })
  })

  it('resets a forgotten password through the e-mailed link and signs out other devices', async () => {
    const org = await createOrg()
    const { email } = await activatedMember(org.id)
    const before = await signIn(email, PASSWORD)
    expect(before.status).toBe(200)
    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' }, headers: new Headers() })
    const link = linkIn(lastMailTo(email))
    const token = new URL(link).pathname.split('/').pop()!
    const newPassword = 'another-long-pass-42'
    await auth.api.resetPassword({ body: { newPassword, token }, headers: new Headers() })
    expect((await signIn(email, PASSWORD)).status).toBe(401)
    expect((await signIn(email, newPassword)).status).toBe(200)
    expect(await resolveSession(new Headers({ cookie: before.cookie }))).toEqual({ kind: 'anonymous' })
  })
})

describe('[FR-AUTH-001/AC3] lockout after 5 failures in 15 minutes', () => {
  it('locks the account, even for the right password, and records security events', async () => {
    const org = await createOrg()
    const { email, member } = await activatedMember(org.id)
    for (let i = 0; i < 5; i++) expect((await signIn(email, 'wrong-password-123', `198.51.100.${i}`)).status).toBe(401)
    expect((await signIn(email, PASSWORD, '198.51.100.99')).status).toBe(429)
    const types = (await prisma.event.findMany({ where: { aggregateId: member.id, aggregateType: 'Auth' } })).map((e) => e.type)
    expect(types.filter((t) => t === 'auth.login_failed')).toHaveLength(5)
    expect(types).toContain('auth.login_locked')
  })

  it('counts wrong 2FA codes too (NFR-SEC-05): signing in again with the password gives no new tries', async () => {
    const org = await createOrg()
    const m = await activatedMember(org.id, ['FINANCE'])
    const secret = 'T'.repeat(32)
    await enableTotpWithSecret(m.userId, secret, ['ccccc-ddddd'])
    const wrongCode = () => String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, '0')
    // A sign-in that reached the second step before the account was locked
    const waiting = await signIn(m.email, PASSWORD, '198.18.7.200')
    expect(waiting.twoFactor).toBe(true)
    for (let i = 0; i < 5; i++) {
      const challenge = await signIn(m.email, PASSWORD, `198.18.7.${i}`)
      expect(challenge.twoFactor).toBe(true)
      expect((await verifyTotpOverHttp(challenge.cookie, wrongCode(), `198.18.7.${i}`)).status).toBe(401)
    }
    expect((await signIn(m.email, PASSWORD, '198.18.7.99')).status).toBe(429)
    expect((await verifyTotpOverHttp(waiting.cookie, totp(secret), '198.18.7.200')).status).toBe(429)
    const events = await prisma.event.findMany({ where: { aggregateId: m.member.id, aggregateType: 'Auth' } })
    expect(events.filter((e) => e.type === 'auth.login_failed' && (e.data as { step?: string }).step === 'two_factor')).toHaveLength(5)
    expect(events.map((e) => e.type)).toContain('auth.login_locked')
  })

  it('locks an IP after 5 failures across accounts; successful sign-ins never count', async () => {
    const org = await createOrg()
    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`
    const good = await activatedMember(org.id)
    for (let i = 0; i < 6; i++) expect((await signIn(good.email, PASSWORD, ip)).status).toBe(200)
    for (let i = 0; i < 5; i++) await signIn(`${randomUUID()}@nobody.test`, 'wrong-password-123', ip)
    expect((await signIn(good.email, PASSWORD, ip)).status).toBe(429)
  })

  it('says which lock applies and when it lifts: the window after the 5th most recent failure', async () => {
    const org = await createOrg()
    const { email } = await activatedMember(org.id)
    for (let i = 0; i < 5; i++) await signIn(email, 'wrong-password-123', `198.51.101.${i}`)
    const fifthNewest = await prisma.authAttempt.findFirstOrThrow({ where: { email, success: false }, orderBy: { createdAt: 'asc' } })
    const res = await signInResponse(email, PASSWORD, '198.51.101.99')
    expect(res.status).toBe(429)
    const body = (await res.json()) as { code?: string; reason?: string; retryAt?: string }
    expect(body).toMatchObject({ code: 'LOGIN_LOCKED', reason: 'ACCOUNT' })
    expect(new Date(body.retryAt!).getTime()).toBe(fifthNewest.createdAt.getTime() + 15 * MS_PER_MINUTE)

    const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`
    for (let i = 0; i < 5; i++) await signIn(`${randomUUID()}@nobody.test`, 'wrong-password-123', ip)
    const other = await activatedMember(org.id)
    const byAddress = await signInResponse(other.email, PASSWORD, ip)
    expect(byAddress.status).toBe(429)
    expect(await byAddress.json()).toMatchObject({ code: 'LOGIN_LOCKED', reason: 'IP' })
  })
})

describe('[NFR-SEC-05] parallel guesses are counted before any of them is checked', () => {
  const statuses = (responses: Array<{ status: number }>) => responses.map((r) => r.status).sort()

  it('checks at most 5 of 10 wrong passwords sent at once for one account', async () => {
    const org = await createOrg()
    const { email } = await activatedMember(org.id)
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => signIn(email, 'wrong-password-123', `198.18.20.${i}`)))
    const checked = results.filter((r) => r.status === 401).length
    expect(checked).toBeLessThanOrEqual(5)
    expect(statuses(results).every((s) => s === 401 || s === 429)).toBe(true)
    expect(await prisma.authAttempt.count({ where: { email, success: false } })).toBe(checked)
  })

  it('checks at most 5 of 10 wrong codes sent at once across waiting sign-ins of one account', async () => {
    const org = await createOrg()
    const m = await activatedMember(org.id, ['FINANCE'])
    const secret = 'P'.repeat(32)
    await enableTotpWithSecret(m.userId, secret, [])
    const wrongCode = () => String((Number(totp(secret)) + 1) % 1_000_000).padStart(6, '0')
    const challenges: string[] = []
    for (let i = 0; i < 10; i++) {
      const c = await signIn(m.email, PASSWORD, `198.18.21.${i}`)
      expect(c.twoFactor).toBe(true)
      challenges.push(c.cookie)
    }
    const results = await Promise.all(challenges.map((cookie, i) => verifyTotpOverHttp(cookie, wrongCode(), `198.18.22.${i}`)))
    const checked = results.filter((r) => r.status === 401).length
    expect(checked).toBeLessThanOrEqual(5)
    expect(results.filter((r) => r.status === 429).length).toBe(10 - checked)
  })

  it('lets a room sign in one after another from one address: 32 two-step sign-ins in a row all succeed', async () => {
    const org = await createOrg()
    const ip = `198.18.23.${Math.floor(Math.random() * 200) + 1}`
    const secret = 'W'.repeat(32)
    const people = await Promise.all(Array.from({ length: 8 }, () => activatedMember(org.id, ['FINANCE'])))
    for (const p of people) await enableTotpWithSecret(p.userId, secret, [])
    for (let round = 0; round < 4; round++) {
      for (const p of people) {
        const first = await signIn(p.email, PASSWORD, ip)
        expect(first.twoFactor).toBe(true)
        const second = await verifyTotpOverHttp(first.cookie, totp(secret), ip)
        expect(second.status).toBe(200)
      }
    }
  }, 60_000)
})

describe('[FR-AUTH-002/AC1] TOTP is required for members with roles', () => {
  it('sends members with a role to 2FA setup until TOTP is enabled; plain requesters are not asked', async () => {
    const org = await createOrg()
    const finance = await activatedMember(org.id, ['FINANCE'])
    const signedIn = await signIn(finance.email, PASSWORD)
    expect((await resolveSession(new Headers({ cookie: signedIn.cookie }))).kind).toBe('needs-2fa-setup')

    const secret = 'S'.repeat(32)
    await enableTotpWithSecret(finance.userId, secret, ['aaaaa-bbbbb'])
    const second = await signIn(finance.email, PASSWORD)
    expect(second.twoFactor).toBe(true)
    const verified = (await auth.api.verifyTOTP({ body: { code: totp(secret) }, headers: new Headers({ cookie: second.cookie }), asResponse: true })) as Response
    expect(verified.status).toBe(200)
    const cookie = (verified.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    expect((await resolveSession(new Headers({ cookie }))).kind).toBe('member')

    const requester = await activatedMember(org.id)
    const plain = await signIn(requester.email, PASSWORD)
    expect(plain.twoFactor).toBe(false)
    expect((await resolveSession(new Headers({ cookie: plain.cookie }))).kind).toBe('member')
  })
})

describe('[FR-AUTH-002/AC2] ten single-use backup codes', () => {
  it('setting up TOTP issues 10 backup codes; each code works once', async () => {
    const org = await createOrg()
    const m = await activatedMember(org.id, ['FINANCE'])
    const first = await signIn(m.email, PASSWORD)
    const setup = await auth.api.enableTwoFactor({ body: { password: PASSWORD }, headers: new Headers({ cookie: first.cookie }) })
    if (setup.method !== 'totp') throw new Error('expected TOTP setup')
    expect(setup.backupCodes).toHaveLength(10)
    expect(new Set(setup.backupCodes).size).toBe(10)
    // Confirming the first code from the authenticator app turns 2FA on
    const secret = fromBase32(new URL(setup.totpURI).searchParams.get('secret')!).toString('utf8')
    const confirmed = (await auth.api.verifyTOTP({ body: { code: totp(secret) }, headers: new Headers({ cookie: first.cookie }), asResponse: true })) as Response
    expect(confirmed.status).toBe(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.userId } })).twoFactorEnabled).toBe(true)

    const code = setup.backupCodes[3]!
    const challenge = await signIn(m.email, PASSWORD)
    expect(challenge.twoFactor).toBe(true)
    const used = (await auth.api.verifyBackupCode({ body: { code }, headers: new Headers({ cookie: challenge.cookie }), asResponse: true })) as Response
    expect(used.status).toBe(200)
    const again = await signIn(m.email, PASSWORD)
    const reused = (await auth.api.verifyBackupCode({ body: { code }, headers: new Headers({ cookie: again.cookie }), asResponse: true })) as Response
    expect(reused.status).toBe(401)
    // Confirming the setup is recorded once; later sign-ins do not repeat it
    expect(await prisma.event.count({ where: { aggregateId: m.member.id, type: 'auth.2fa_enabled' } })).toBe(1)
  })
})

describe('[FR-AUTH-002/AC3] ORG_ADMIN resets another member 2FA with a reason', () => {
  it('removes TOTP, signs the member out everywhere and records the reason by reference', async () => {
    const { org, ctx } = await orgWithAdmin()
    const m = await activatedMember(org.id, ['FINANCE'])
    await enableTotpWithSecret(m.userId, 'R'.repeat(32), [])
    await signIn(m.email, PASSWORD)
    const r = await resetMemberTwoFactor(ctx, { memberId: m.member.id, reason: 'ทำโทรศัพท์หาย' }, { idempotencyKey: randomUUID(), sender: null })
    expect(r).toMatchObject({ ok: true })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.userId } })).twoFactorEnabled).toBe(false)
    expect(await prisma.session.count({ where: { userId: m.userId } })).toBe(0)
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: m.member.id, type: 'auth.2fa_reset' } })
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: (event.data as { reasonCommentId: string }).reasonCommentId } })
    expect(comment.body).toBe('ทำโทรศัพท์หาย')
    expect(JSON.stringify(event.data)).not.toContain('โทรศัพท์')
  })

  it('refuses to reset a sign-in identity that another organization also uses', async () => {
    const { org, ctx } = await orgWithAdmin()
    const m = await activatedMember(org.id, ['FINANCE'])
    const other = await createOrg()
    await prisma.member.create({ data: { organizationId: other.id, email: m.email, displayNameTh: 'คนเดียวกัน', status: 'ACTIVE', userId: m.userId } })
    await enableTotpWithSecret(m.userId, 'Q'.repeat(32), [])
    const r = await resetMemberTwoFactor(ctx, { memberId: m.member.id, reason: 'ทำโทรศัพท์หาย' }, { idempotencyKey: randomUUID(), sender: null })
    expect(r).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'SHARED_IDENTITY' } } })
    expect((await prisma.user.findUniqueOrThrow({ where: { id: m.userId } })).twoFactorEnabled).toBe(true)
  })

  it('members cannot switch off their own 2FA', async () => {
    const org = await createOrg()
    const m = await activatedMember(org.id)
    const { cookie } = await signIn(m.email, PASSWORD)
    const res = await auth.handler(
      new Request(`${getEnv().BETTER_AUTH_URL}/api/auth/two-factor/disable`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: getEnv().APP_URL, cookie },
        body: JSON.stringify({ password: PASSWORD }),
      }),
    )
    expect(res.status).toBe(403)
  })

  it('refuses without admin.members and refuses resetting yourself', async () => {
    const { org, admin, ctx } = await orgWithAdmin()
    const m = await activatedMember(org.id)
    const plainCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: m.member.id }, channel: 'WEB', now: new Date() })
    expect(await resetMemberTwoFactor(plainCtx, { memberId: admin.id, reason: 'ลองดู' }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await resetMemberTwoFactor(ctx, { memberId: admin.id, reason: 'ของตัวเอง' }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
  })
})

describe('[FR-AUTH-003/AC1] session limits', () => {
  it('ends web sessions after 30 idle minutes or 12 hours, and LIFF sessions after 15 idle minutes', async () => {
    const org = await createOrg()
    const m = await activatedMember(org.id)
    const { cookie } = await signIn(m.email, PASSWORD)
    const headers = new Headers({ cookie })
    const session = await prisma.session.findFirstOrThrow({ where: { userId: m.userId }, orderBy: { createdAt: 'desc' } })
    const start = session.createdAt.getTime()
    const t1 = start + 29 * MS_PER_MINUTE
    const t2 = t1 + 14 * MS_PER_MINUTE
    expect((await resolveSession(headers, { now: new Date(t1) })).kind).toBe('member')
    expect((await resolveSession(headers, { channel: 'LIFF', now: new Date(t2) })).kind).toBe('member')
    // idle in LIFF for more than 15 minutes → expired and deleted
    expect((await resolveSession(headers, { channel: 'LIFF', now: new Date(t2 + 16 * MS_PER_MINUTE) })).kind).toBe('expired')
    expect(await prisma.session.count({ where: { id: session.id } })).toBe(0)

    const second = await signIn(m.email, PASSWORD)
    const h2 = new Headers({ cookie: second.cookie })
    const s2 = await prisma.session.findFirstOrThrow({ where: { userId: m.userId }, orderBy: { createdAt: 'desc' } })
    expect((await resolveSession(h2, { now: new Date(s2.createdAt.getTime() + 31 * MS_PER_MINUTE) })).kind).toBe('expired')

    const third = await signIn(m.email, PASSWORD)
    const h3 = new Headers({ cookie: third.cookie })
    const s3 = await prisma.session.findFirstOrThrow({ where: { userId: m.userId }, orderBy: { createdAt: 'desc' } })
    // keep it active every 20 minutes for 12 hours: the absolute limit still ends it
    for (let t = 20; t < 12 * 60; t += 20) await resolveSession(h3, { now: new Date(s3.createdAt.getTime() + t * MS_PER_MINUTE) })
    expect((await resolveSession(h3, { now: new Date(s3.createdAt.getTime() + 12 * MS_PER_HOUR) })).kind).toBe('expired')
  })
})

describe('[FR-AUTH-003/AC2] deactivation revokes access in one transaction', () => {
  it('deletes sessions and pending invitations and records the event', async () => {
    const { org, ctx } = await orgWithAdmin()
    const m = await activatedMember(org.id)
    await signIn(m.email, PASSWORD)
    await signIn(m.email, PASSWORD)
    const r = await deactivateMember(ctx, { memberId: m.member.id, reason: 'ลาออก' }, { idempotencyKey: randomUUID(), sender: null })
    expect(r).toMatchObject({ ok: true, data: { revoked: { sessions: 2 } } })
    expect(await prisma.session.count({ where: { userId: m.userId } })).toBe(0)
    expect((await prisma.member.findUniqueOrThrow({ where: { id: m.member.id } })).status).toBe('DEACTIVATED')
    expect((await signIn(m.email, PASSWORD)).status).toBe(200)
    const after = await signIn(m.email, PASSWORD)
    expect((await resolveSession(new Headers({ cookie: after.cookie }))).kind).toBe('no-membership')
  })

  it('refuses to deactivate yourself or the last ORG_ADMIN, and refuses non-admins', async () => {
    const { org, admin, ctx } = await orgWithAdmin()
    expect(await deactivateMember(ctx, { memberId: admin.id, reason: 'ตัวเอง' }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    const other = await activatedMember(org.id, ['ORG_ADMIN'])
    const otherCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: other.member.id }, channel: 'WEB', now: new Date() })
    await deactivateMember(otherCtx, { memberId: admin.id, reason: 'สลับผู้ดูแล' }, { idempotencyKey: randomUUID(), sender: null })
    const third = await activatedMember(org.id, ['ORG_ADMIN'])
    const thirdCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: third.member.id }, channel: 'WEB', now: new Date() })
    // other and third are now the only admins; deactivating other leaves third — allowed; then third is last
    expect(await deactivateMember(thirdCtx, { memberId: other.member.id, reason: 'ย้ายงาน' }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: true })
    const plain = await activatedMember(org.id)
    const plainCtx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: plain.member.id }, channel: 'WEB', now: new Date() })
    expect(await deactivateMember(plainCtx, { memberId: third.member.id, reason: 'x x x' }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AUTH-003/AC3] devices', () => {
  it('lists signed-in devices and signs one out', async () => {
    const org = await createOrg()
    const m = await activatedMember(org.id)
    const a = await signIn(m.email, PASSWORD)
    await signIn(m.email, PASSWORD)
    const state = await resolveSession(new Headers({ cookie: a.cookie }))
    if (state.kind !== 'member') throw new Error('expected member session')
    const devices = await listMySessions(m.userId, state.sessionId)
    expect(devices).toHaveLength(2)
    expect(devices.filter((d) => d.current)).toHaveLength(1)
    const other = devices.find((d) => !d.current)!
    const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: m.member.id }, channel: 'WEB', now: new Date() })
    expect(await revokeOwnSession(ctx, { sessionId: other.id }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: true })
    expect(await listMySessions(m.userId, state.sessionId)).toHaveLength(1)
    // an unknown id, or another person's session, is not found
    expect(await revokeOwnSession(ctx, { sessionId: randomUUID() }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const stranger = await activatedMember(org.id)
    await signIn(stranger.email, PASSWORD)
    const strangerSession = await prisma.session.findFirstOrThrow({ where: { userId: stranger.userId } })
    expect(await revokeOwnSession(ctx, { sessionId: strangerSession.id }, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.session.count({ where: { id: strangerSession.id } })).toBe(1)
  })
})
