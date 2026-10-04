import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/liff/session/route'
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { auth } from '@/server/auth/auth'
import { LIFF_SESSION_ALLOWED_PATHS, LIFF_SESSION_TOKEN_PREFIX, liffSessionIdentityId, newLiffSessionToken, setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { ORG_COOKIE, resolvePlatformSession, resolveSession } from '@/server/auth/session'
import { listMySessions } from '@/server/auth/sessions'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { startFakeLine, type FakeLine } from '../../scripts/lib/fake-line'
import { newLineUserId } from '../../scripts/line-simulate'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-03 · the LIFF session (§9.4, ADR-024, ADR-040). The LIFF page posts liff.getIDToken() to POST /api/liff/session; the
// server has LINE's verify endpoint check it for our LIFF channel (here the fake LINE server of the repo, which verifies
// only tokens it issued, as LINE does) and checks the claims itself — BR-LINE-02 — and never takes a LINE user id or a
// profile from the browser — BR-LINE-01. Only a LINE user linked to an active member of an organization whose LINE
// channel is on gets a session; that session stands on the very link it was opened with (its token names it) and acts
// only as that link's member while that link stands, serves LIFF pages only (Better Auth's own endpoints refuse it too,
// and the few it may reach drop it once its link is gone), ends after 15 idle minutes and is renewed with a new ID token
// — never in place of another identity's live session (FR-AUTH-003 AC1). A request a page makes by itself is no activity of
// its session (touch: false), and the list of signed-in devices shows live sessions only (FR-AUTH-003 AC3).

const LIFF_CHANNEL = '1650000003'
const PROVIDER = '1650000001'
const PASSWORD = 'liff-user-password-1'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000002',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: `${LIFF_CHANNEL}-AbCdEfGh`,
  liffChannelId: LIFF_CHANNEL,
}

const line = withFakeLine()
/** Another LINE server's tokens: right sub and aud, but not issued by the LINE the app asks */
let elsewhere: FakeLine
/** What the app sent to LINE's verify endpoint */
const verifyCalls: Array<{ url: string; body: URLSearchParams }> = []
let lineDown = false

/** LINE's verify endpoint as the fake LINE server answers it */
const viaFakeLine: typeof fetch = async (input, init) => {
  verifyCalls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? '')) })
  if (lineDown) return new Response('upstream error', { status: 503 })
  return fetch(String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url), init)
}

beforeAll(async () => {
  elsewhere = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET })
  setLiffVerification({ channelId: LIFF_CHANNEL, fetch: viaFakeLine })
})
afterAll(async () => {
  setLiffVerification(null)
  await elsewhere.close()
})

/** An organization with its LINE channel saved by its ORG_ADMIN */
async function lineOrg(overrides: { active?: boolean; liffChannelId?: string } = {}) {
  const org = await createOrg()
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: new Date() })
  const liff = overrides.liffChannelId ? { liffId: `${overrides.liffChannelId}-AbCdEfGh`, liffChannelId: overrides.liffChannelId } : {}
  const saved = await saveLineChannelSettings(ctx, { ...CHANNEL, ...liff, active: overrides.active ?? true }, { idempotencyKey: randomUUID(), sender: null })
  if (!saved.ok) throw new Error(saved.error.code)
  return org.id
}

/** A LINE link as S5-04's link makes it */
async function link(orgId: string, memberId: string, lineUserId: string, options: { providerKey?: string; unlinked?: boolean } = {}) {
  return prisma.channelIdentity.create({
    data: {
      organizationId: orgId,
      memberId,
      channel: 'LINE',
      providerKey: options.providerKey ?? PROVIDER,
      externalUserId: lineUserId,
      linkedAt: new Date(),
      ...(options.unlinked ? { unlinkedAt: new Date() } : {}),
    },
  })
}

/** A signed-up member (a Better Auth identity with a password) whose LINE account is linked */
async function linkedUser(orgId: string, options: { lineUserId?: string; providerKey?: string; unlinked?: boolean } = {}) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ LIFF', password: PASSWORD })
  const member = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้ LIFF', status: 'ACTIVE', userId } })
  const lineUserId = options.lineUserId ?? newLineUserId()
  await link(orgId, member.id, lineUserId, options)
  return { userId, email, memberId: member.id, lineUserId }
}

const tokenFor = (sub: string, extra: { aud?: string; expiresInSeconds?: number } = {}) => line.fake.issueIdToken({ sub, aud: extra.aud ?? LIFF_CHANNEL, ...(extra.expiresInSeconds === undefined ? {} : { expiresInSeconds: extra.expiresInSeconds }) })

/** An address of its own per request, so Better Auth's per-address rate limit never joins in */
const someAddress = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`

const sessionCookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => c.includes('session_token=') && !c.endsWith('='))
    .join('; ')

/** POST /api/liff/session as the LIFF page does (same origin) */
async function liffSignIn(body: unknown, options: { cookie?: string; origin?: string; headers?: Record<string, string> } = {}) {
  const env = getEnv()
  const response = await POST(
    new Request(`${env.APP_URL.replace(/\/+$/, '')}/api/liff/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: options.origin ?? new URL(env.APP_URL).origin,
        'x-forwarded-for': someAddress(),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
  return { status: response.status, cookie: sessionCookieOf(response), body: (await response.json().catch(() => null)) as Record<string, unknown> | null }
}

/** A request to one of Better Auth's own endpoints (/api/auth/…), from a page of this site */
async function betterAuth(path: string, options: { method?: string; cookie?: string; body?: unknown } = {}) {
  const env = getEnv()
  const method = options.method ?? 'POST'
  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method,
      headers: {
        origin: new URL(env.APP_URL).origin,
        'x-forwarded-for': someAddress(),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(options.body ?? {}) }),
    }),
  )
  const text = await response.text()
  let body: Record<string, unknown> | null = null
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = null
  }
  return { status: response.status, body, cookie: sessionCookieOf(response) }
}

const sessionsOf = (userId: string) => prisma.session.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })
const passwordOf = async (userId: string) => (await prisma.account.findFirstOrThrow({ where: { userId, providerId: 'credential' } })).password

/** A web session of the user (what a password and TOTP sign-in leaves), written as Better Auth writes one */
async function webSession(userId: string) {
  const now = new Date()
  return prisma.session.create({
    data: { id: randomUUID(), token: randomBytes(24).toString('hex'), userId, expiresAt: new Date(now.getTime() + 12 * MS_PER_HOUR), createdAt: now, updatedAt: now },
  })
}

/** A session row with this token and these times, as Better Auth writes one (12 hours from its start unless told) */
async function sessionRow(userId: string, token: string, times: { createdAt?: Date; lastActiveAt?: Date | null; expiresAt?: Date } = {}) {
  const createdAt = times.createdAt ?? new Date()
  return prisma.session.create({
    data: { id: randomUUID(), token, userId, createdAt, updatedAt: createdAt, lastActiveAt: times.lastActiveAt ?? null, expiresAt: times.expiresAt ?? new Date(createdAt.getTime() + 12 * MS_PER_HOUR) },
  })
}

/** A LIFF token as the sign-in made them before sessions were bound to their link: the prefix and random characters */
const unboundLiffToken = () => `${LIFF_SESSION_TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`

/** The cookie Better Auth signs for a session token (better-call: HMAC-SHA256 with the auth secret, URI-encoded) */
async function signedCookieFor(token: string): Promise<string> {
  const context = await auth.$context
  const signature = createHmac('sha256', context.secret).update(token).digest('base64')
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`
}

const liffSessionOf = async (userId: string) => (await sessionsOf(userId)).find((s) => s.token.startsWith(LIFF_SESSION_TOKEN_PREFIX))

describe('[BR-LINE-02] the ID token is checked with LINE’s verify endpoint for our LIFF channel', () => {
  it('a token LINE issued for our LIFF channel signs the linked member in with a LIFF session', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    expect(r.status).toBe(200)
    expect(r.cookie).toContain('session_token=')
    const call = verifyCalls.at(-1)!
    expect(call.url).toBe(`${getEnv().LINE_API_BASE_URL}/oauth2/v2.1/verify`)
    expect(call.body.get('client_id')).toBe(LIFF_CHANNEL)
    const [session] = await sessionsOf(linked.userId)
    expect(session!.token.startsWith(LIFF_SESSION_TOKEN_PREFIX)).toBe(true)
    expect(await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', userId: linked.userId, member: { id: linked.memberId, organizationId: orgId } })
  })

  it('refuses a token that LINE did not issue, one for another channel (aud) and an expired one: 401 and no session', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const refused = {
      'not issued by LINE': elsewhere.issueIdToken({ sub: linked.lineUserId, aud: LIFF_CHANNEL }),
      'made up': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMCJ9.c2lnbmF0dXJl',
      'another channel (aud)': tokenFor(linked.lineUserId, { aud: '1999999999' }),
      expired: tokenFor(linked.lineUserId, { expiresInSeconds: -5 }),
    }
    for (const [what, idToken] of Object.entries(refused)) {
      const r = await liffSignIn({ idToken })
      expect({ what, status: r.status, cookie: r.cookie }).toEqual({ what, status: 401, cookie: '' })
      expect(r.body).toMatchObject({ code: 'TOKEN_INVALID' })
    }
    expect(await sessionsOf(linked.userId)).toEqual([])
  })

  it('checks iss, aud, exp and sub itself, even when LINE’s verify endpoint answers 200', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const nowSeconds = () => Math.floor(Date.now() / MS_PER_SECOND)
    const claims = (overrides: Record<string, unknown>) => {
      const base: Record<string, unknown> = { iss: 'https://access.line.me', sub: linked.lineUserId, aud: LIFF_CHANNEL, exp: nowSeconds() + 600, iat: nowSeconds() }
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete base[key]
        else base[key] = value
      }
      return base
    }
    const answers: Record<string, Record<string, unknown>> = {
      'for another channel (aud)': claims({ aud: '1999999999' }),
      'expired (exp)': claims({ exp: nowSeconds() - 10 }),
      'from another issuer (iss)': claims({ iss: 'https://example.com' }),
      'without a user (sub)': claims({ sub: '' }),
      'without an expiry (exp)': claims({ exp: undefined }),
      'with exp as text': claims({ exp: String(nowSeconds() + 600) }),
    }
    // A stand-in for LINE's verify endpoint that answers 200 with the claims each token names
    setLiffVerification({
      channelId: LIFF_CHANNEL,
      fetch: async (_input, init) => {
        const idToken = new URLSearchParams(String(init?.body ?? '')).get('id_token') ?? ''
        return idToken === 'good' ? Response.json(claims({})) : Response.json(answers[idToken] ?? {})
      },
    })
    try {
      for (const what of Object.keys(answers)) {
        const r = await liffSignIn({ idToken: what })
        expect({ what, status: r.status, cookie: r.cookie, code: r.body?.code }).toEqual({ what, status: 401, cookie: '', code: 'TOKEN_INVALID' })
      }
      expect(await sessionsOf(linked.userId)).toEqual([])
      // The same stand-in with the right claims signs in: the refusals above come from the claims
      expect((await liffSignIn({ idToken: 'good' })).status).toBe(200)
      expect(await sessionsOf(linked.userId)).toHaveLength(1)
    } finally {
      setLiffVerification({ channelId: LIFF_CHANNEL, fetch: viaFakeLine })
    }
  })

  it('reports LINE being unreachable as such (503), not as a bad token, and opens no session', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    lineDown = true
    try {
      expect((await liffSignIn({ idToken: tokenFor(linked.lineUserId) })).status).toBe(503)
    } finally {
      lineDown = false
    }
    expect(await sessionsOf(linked.userId)).toEqual([])
  })
})

describe('[BR-LINE-01] the server takes the LINE user from the verified ID token only, never from the browser', () => {
  it('refuses a LINE user id or a profile sent with the token or instead of it; a header naming another user changes nothing', async () => {
    const orgId = await lineOrg()
    const me = await linkedUser(orgId)
    const someoneElse = await linkedUser(orgId)
    const myToken = tokenFor(me.lineUserId)
    for (const body of [
      { idToken: myToken, userId: someoneElse.lineUserId },
      { userId: someoneElse.lineUserId },
      { idToken: myToken, profile: { userId: someoneElse.lineUserId, displayName: 'คนอื่น' } },
      { idToken: '' },
      'not json',
    ]) {
      const r = await liffSignIn(body)
      expect(r.status).toBe(400)
      expect(r.cookie).toBe('')
    }
    expect(await sessionsOf(someoneElse.userId)).toEqual([])
    expect(await sessionsOf(me.userId)).toEqual([])

    const r = await liffSignIn({ idToken: myToken }, { headers: { 'x-line-user-id': someoneElse.lineUserId } })
    expect(r.status).toBe(200)
    expect(await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', userId: me.userId })
    expect(await sessionsOf(someoneElse.userId)).toEqual([])
  })

  it('answers 403 LINK_REQUIRED unless the LINE user is linked to an active member of an organization whose LINE channel is on and uses this LIFF channel', async () => {
    const on = await lineOrg()
    const off = await lineOrg({ active: false })
    const otherLiff = await lineOrg({ liffChannelId: '1650000999' })
    const cases = {
      'never linked': { lineUserId: newLineUserId() },
      'link ended': await linkedUser(on, { unlinked: true }),
      'linked under another provider': await linkedUser(on, { providerKey: '1999999999' }),
      'channel switched off': await linkedUser(off),
      'organization uses another LIFF channel': await linkedUser(otherLiff),
      'member deactivated': await (async () => {
        const linked = await linkedUser(on)
        await prisma.member.update({ where: { id: linked.memberId }, data: { status: 'DEACTIVATED' } })
        return linked
      })(),
    }
    for (const [what, { lineUserId }] of Object.entries(cases)) {
      const r = await liffSignIn({ idToken: tokenFor(lineUserId) })
      expect({ what, status: r.status, body: r.body, cookie: r.cookie }).toMatchObject({ what, status: 403, body: { code: 'FORBIDDEN', reason: 'LINK_REQUIRED' }, cookie: '' })
    }
  })

  it('refuses a LINE account linked to members of two different sign-in identities instead of choosing one', async () => {
    const first = await lineOrg()
    const second = await lineOrg()
    const a = await linkedUser(first)
    const b = await linkedUser(second, { lineUserId: a.lineUserId })
    const r = await liffSignIn({ idToken: tokenFor(a.lineUserId) })
    expect(r).toMatchObject({ status: 403, body: { code: 'FORBIDDEN', reason: 'LINK_AMBIGUOUS' }, cookie: '' })
    expect([...(await sessionsOf(a.userId)), ...(await sessionsOf(b.userId))]).toEqual([])
  })

  it('guards the plugin’s own path (/api/auth/liff/session) the same way: the token only, from this site only', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const someoneElse = await linkedUser(orgId)
    const env = getEnv()
    const direct = (body: unknown, headers: Record<string, string> = {}) =>
      auth.handler(
        new Request(`${env.BETTER_AUTH_URL}/api/auth/liff/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin, 'x-forwarded-for': someAddress(), ...headers },
          body: JSON.stringify(body),
        }),
      )
    const idToken = tokenFor(linked.lineUserId)
    expect((await direct({ idToken, userId: someoneElse.lineUserId })).status).toBe(400)
    expect((await direct({ idToken }, { origin: 'https://attacker.example' })).status).toBe(403)
    expect((await direct({ idToken }, { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status).toBe(403)
    expect([...(await sessionsOf(linked.userId)), ...(await sessionsOf(someoneElse.userId))]).toEqual([])
    expect((await direct({ idToken })).status).toBe(200)
    expect(await sessionsOf(linked.userId)).toHaveLength(1)
  })

  it('refuses a request from another site’s page (403) and a body above the limit (413)', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    expect((await liffSignIn({ idToken: tokenFor(linked.lineUserId) }, { origin: 'https://attacker.example' })).status).toBe(403)
    expect((await liffSignIn({ idToken: tokenFor(linked.lineUserId) }, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect((await liffSignIn(JSON.stringify({ idToken: 'x'.repeat(40_000) }))).status).toBe(413)
    expect(await sessionsOf(linked.userId)).toEqual([])
  })
})

describe('[FR-AUTH-002/AC1] a LINE login never becomes a workspace login: Better Auth refuses a LIFF session outside the LIFF endpoints', () => {
  it('refuses a password change that signs in anew, TOTP setup and checks, the session list and user edits: no other session appears and nothing changes', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    // An ORG_ADMIN with TOTP: the workspace asks for the password and the code (FR-AUTH-002 AC1)
    await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: linked.memberId, role: 'ORG_ADMIN', grantedAt: new Date() } })
    await prisma.user.update({ where: { id: linked.userId }, data: { twoFactorEnabled: true } })
    const web = await webSession(linked.userId)
    const signedIn = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    expect(signedIn.status).toBe(200)
    const password = await passwordOf(linked.userId)

    const attempts: Array<[string, string, unknown?]> = [
      ['/change-password', 'POST', { currentPassword: PASSWORD, newPassword: 'another-password-123', revokeOtherSessions: true }],
      ['/change-password', 'POST', { currentPassword: PASSWORD, newPassword: 'another-password-123' }],
      ['/two-factor/enable', 'POST', { password: PASSWORD }],
      ['/two-factor/get-totp-uri', 'POST', { password: PASSWORD }],
      ['/two-factor/verify-totp', 'POST', { code: '123456' }],
      ['/two-factor/generate-backup-codes', 'POST', { password: PASSWORD }],
      ['/list-sessions', 'GET'],
      ['/revoke-other-sessions', 'POST', {}],
      ['/revoke-sessions', 'POST', {}],
      ['/update-user', 'POST', { name: 'ชื่อใหม่' }],
    ]
    for (const [path, method, body] of attempts) {
      const r = await betterAuth(path, { method, cookie: signedIn.cookie, body })
      expect({ path, status: r.status, reason: r.body?.reason, cookie: r.cookie }).toEqual({ path, status: 403, reason: 'LIFF_SESSION', cookie: '' })
      expect(JSON.stringify(r.body)).not.toContain(LIFF_SESSION_TOKEN_PREFIX)
    }

    // The LIFF session and the web session are still the only ones; password, name and TOTP are as they were
    const sessions = await sessionsOf(linked.userId)
    expect(sessions.map((s) => s.id).sort()).toEqual([web.id, sessions.find((s) => s.token.startsWith(LIFF_SESSION_TOKEN_PREFIX))!.id].sort())
    expect(await passwordOf(linked.userId)).toBe(password)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: linked.userId } })).toMatchObject({ name: 'ผู้ใช้ LIFF', twoFactorEnabled: true })
    expect(await prisma.twoFactor.count({ where: { userId: linked.userId } })).toBe(0)
    // and the LIFF cookie still opens LIFF pages only
    const headers = new Headers({ cookie: signedIn.cookie })
    expect((await resolveSession(headers, { channel: 'WEB' })).kind).toBe('anonymous')
    expect((await resolveSession(headers, { channel: 'LIFF' })).kind).toBe('member')
  })

  it('refuses it on every endpoint Better Auth serves but the few LIFF needs: reading the session, renewal, sign-out', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const signedIn = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const endpoints = Object.values(auth.api as unknown as Record<string, { path?: string; options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } } }>).filter(
      (e) => typeof e.path === 'string' && !e.options?.metadata?.SERVER_ONLY,
    )
    const answers: Array<{ path: string; method: string; status: number; reason: unknown }> = []
    for (const endpoint of endpoints) {
      if (LIFF_SESSION_ALLOWED_PATHS.has(endpoint.path!)) continue
      for (const method of [endpoint.options?.method ?? 'POST'].flat()) {
        const r = await betterAuth(endpoint.path!.replace(/:\w+/g, 'x'), { method, cookie: signedIn.cookie, body: {} })
        answers.push({ path: endpoint.path!, method, status: r.status, reason: r.body?.reason })
      }
    }
    // Members cannot switch their own 2FA off whatever their session (auth.ts): refused before the LIFF check
    const expected = answers.map((a) => ({ ...a, status: 403, reason: a.path === '/two-factor/disable' ? a.reason : 'LIFF_SESSION' }))
    expect(answers).toEqual(expected)
    expect(answers.length).toBeGreaterThan(25)
    expect(answers.map((a) => a.path)).toEqual(expect.arrayContaining(['/change-password', '/two-factor/enable', '/two-factor/verify-totp', '/list-sessions', '/update-user', '/update-session']))
    expect((await sessionsOf(linked.userId)).map((s) => s.token.startsWith(LIFF_SESSION_TOKEN_PREFIX))).toEqual([true])

    // What LIFF needs still works: reading the session, then signing out ends it
    const read = await betterAuth('/get-session', { method: 'GET', cookie: signedIn.cookie })
    expect(read).toMatchObject({ status: 200, body: { user: { id: linked.userId } } })
    expect((await betterAuth('/sign-out', { cookie: signedIn.cookie })).status).toBe(200)
    expect(await sessionsOf(linked.userId)).toEqual([])
  })

  it('lets a LINE browser sign in with the password: the e-mail sign-in replaces the LIFF cookie with a web session', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const signedIn = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const r = await betterAuth('/sign-in/email', { cookie: signedIn.cookie, body: { email: linked.email, password: PASSWORD } })
    expect(r.status).toBe(200)
    const sessions = await sessionsOf(linked.userId)
    const web = sessions.find((s) => !s.token.startsWith(LIFF_SESSION_TOKEN_PREFIX))
    expect(web).toBeDefined()
    expect(await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'WEB' })).toMatchObject({ kind: 'member', sessionId: web!.id })
  })
})

describe('[FR-AUTH-001/AC3] a LIFF session is no way round the sign-in lockout', () => {
  it('never checks a password: change-password answers the same for the right and a wrong one, however often', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const signedIn = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const password = await passwordOf(linked.userId)
    const guesses = ['wrong-password-0001', 'wrong-password-0002', 'wrong-password-0003', 'wrong-password-0004', 'wrong-password-0005', 'wrong-password-0006', PASSWORD]
    for (const currentPassword of guesses) {
      const r = await betterAuth('/change-password', { cookie: signedIn.cookie, body: { currentPassword, newPassword: 'another-password-123' } })
      expect({ status: r.status, reason: r.body?.reason }).toEqual({ status: 403, reason: 'LIFF_SESSION' })
    }
    expect(await passwordOf(linked.userId)).toBe(password)
  })
})

describe('[FR-AUTH-003/AC1] a LIFF session ends after 15 idle minutes, is renewed with a new ID token and serves LIFF pages only', () => {
  it('ends after 15 idle minutes and is deleted; a new ID token renews it and replaces the session the browser held', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const first = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const [s1] = await sessionsOf(linked.userId)
    const h1 = new Headers({ cookie: first.cookie })
    const start = s1!.createdAt.getTime()
    expect((await resolveSession(h1, { channel: 'LIFF', now: new Date(start + 14 * MS_PER_MINUTE) })).kind).toBe('member')
    // 15 minutes without a request after the last one: over
    expect((await resolveSession(h1, { channel: 'LIFF', now: new Date(start + 29 * MS_PER_MINUTE) })).kind).toBe('expired')
    expect(await sessionsOf(linked.userId)).toEqual([])

    // Silent renewal: the page sends a new ID token with the cookie it still has
    const second = await liffSignIn({ idToken: tokenFor(linked.lineUserId) }, { cookie: first.cookie })
    expect(second.status).toBe(200)
    const [s2, ...none] = await sessionsOf(linked.userId)
    expect(none).toEqual([])
    expect(await resolveSession(new Headers({ cookie: second.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', sessionId: s2!.id })

    // Renewing while the session still runs replaces it too: one session per browser, nothing left behind
    const third = await liffSignIn({ idToken: tokenFor(linked.lineUserId) }, { cookie: second.cookie })
    expect(third.status).toBe(200)
    const after = await sessionsOf(linked.userId)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).not.toBe(s2!.id)
    expect((await resolveSession(new Headers({ cookie: second.cookie }), { channel: 'LIFF' })).kind).toBe('anonymous')
  })

  it('is no session for the workspace or the platform screens, and stays for LIFF pages', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const headers = new Headers({ cookie: r.cookie })
    expect((await resolveSession(headers)).kind).toBe('anonymous')
    expect((await resolveSession(headers, { channel: 'WEB' })).kind).toBe('anonymous')
    expect((await resolveSession(headers, { channel: 'PWA' })).kind).toBe('anonymous')
    expect((await resolvePlatformSession(headers)).kind).toBe('anonymous')
    expect(await sessionsOf(linked.userId)).toHaveLength(1)
    expect((await resolveSession(headers, { channel: 'LIFF' })).kind).toBe('member')
  })

  it('ends after 12 hours however active it is', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const headers = new Headers({ cookie: r.cookie })
    const [session] = await sessionsOf(linked.userId)
    const start = session!.createdAt.getTime()
    for (let t = 10; t < 12 * 60; t += 10) expect((await resolveSession(headers, { channel: 'LIFF', now: new Date(start + t * MS_PER_MINUTE) })).kind).toBe('member')
    expect((await resolveSession(headers, { channel: 'LIFF', now: new Date(start + 12 * MS_PER_HOUR) })).kind).toBe('expired')
  })

  it('acts only as a member whose LINE link stands where LINE is on: another organization of the same person is never reached through LINE', async () => {
    // The same person (one sign-in identity) is a member of an organization without LINE (joined first) and of one
    // with LINE, where their LINE account is linked
    const withoutLine = await createOrg()
    const email = `${randomUUID()}@test.bcs.local`
    const userId = await upsertUserWithPassword({ email, name: 'สองบริษัท', password: PASSWORD })
    const elsewhereMember = await prisma.member.create({ data: { organizationId: withoutLine.id, email, displayNameTh: 'สองบริษัท', status: 'ACTIVE', userId } })
    const withLine = await lineOrg()
    const lineMember = await prisma.member.create({ data: { organizationId: withLine, email, displayNameTh: 'สองบริษัท', status: 'ACTIVE', userId } })
    const lineUserId = newLineUserId()
    await link(withLine, lineMember.id, lineUserId)

    const r = await liffSignIn({ idToken: tokenFor(lineUserId) })
    expect(r.status).toBe(200)
    for (const preferred of [undefined, withoutLine.id, withLine]) {
      const cookie = preferred ? `${r.cookie}; ${ORG_COOKIE}=${preferred}` : r.cookie
      expect(await resolveSession(new Headers({ cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', member: { id: lineMember.id, organizationId: withLine } })
    }
    expect(elsewhereMember.createdAt.getTime()).toBeLessThanOrEqual(lineMember.createdAt.getTime())
  })

  it('ends at its next request once the LINE link ends, the organization switches LINE off or moves to another LIFF channel', async () => {
    const changes: Record<string, (orgId: string, linked: Awaited<ReturnType<typeof linkedUser>>) => Promise<unknown>> = {
      'link ended': (orgId, linked) => prisma.channelIdentity.updateMany({ where: { organizationId: orgId, memberId: linked.memberId }, data: { unlinkedAt: new Date() } }),
      'LINE switched off': (orgId) => prisma.lineChannelConfig.update({ where: { organizationId: orgId }, data: { active: false } }),
      'another LIFF channel': (orgId) => prisma.lineChannelConfig.update({ where: { organizationId: orgId }, data: { liffChannelId: '1650000999' } }),
    }
    for (const [what, change] of Object.entries(changes)) {
      const orgId = await lineOrg()
      const linked = await linkedUser(orgId)
      const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
      const headers = new Headers({ cookie: r.cookie })
      expect({ what, kind: (await resolveSession(headers, { channel: 'LIFF' })).kind }).toEqual({ what, kind: 'member' })
      await change(orgId, linked)
      expect({ what, kind: (await resolveSession(headers, { channel: 'LIFF' })).kind }).toEqual({ what, kind: 'anonymous' })
      expect({ what, sessions: await sessionsOf(linked.userId) }).toEqual({ what, sessions: [] })
    }
  })

  it('records each sign-in through LINE like a web one: auth.login_succeeded or auth.login_failed with step liff and channel LIFF, never the token or the LINE user id', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const since = new Date()
    const idToken = tokenFor(linked.lineUserId)
    expect((await liffSignIn({ idToken })).status).toBe(200)
    const [succeeded] = await prisma.event.findMany({ where: { type: 'auth.login_succeeded', aggregateId: linked.memberId } })
    expect(succeeded).toMatchObject({ organizationId: orgId, channel: 'LIFF', actorType: 'USER', actorMemberId: linked.memberId, data: { memberKnown: true, step: 'liff' } })

    const refused = { TOKEN_INVALID: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMCJ9.c2lnbmF0dXJl', LINK_REQUIRED: tokenFor(newLineUserId()) }
    for (const [reason, token] of Object.entries(refused)) {
      const address = `203.0.113.${Object.keys(refused).indexOf(reason) + 1}`
      const r = await liffSignIn({ idToken: token }, { headers: { 'x-forwarded-for': address } })
      expect(r.status).toBe(reason === 'TOKEN_INVALID' ? 401 : 403)
    }
    const failed = await prisma.event.findMany({ where: { type: 'auth.login_failed', channel: 'LIFF', occurredAt: { gte: since } }, orderBy: { seq: 'asc' } })
    const mine = failed.filter((e) => (e.data as { ip?: string }).ip === '203.0.113.x')
    expect(mine.map((e) => [e.organizationId, (e.data as { reason?: string }).reason, (e.data as { step?: string }).step])).toEqual([
      [null, 'TOKEN_INVALID', 'liff'],
      [null, 'LINK_REQUIRED', 'liff'],
    ])
    const recorded = JSON.stringify([succeeded, ...mine].map((e) => ({ ...e, seq: String(e?.seq) })))
    expect(recorded).not.toContain(linked.lineUserId)
    expect(recorded).not.toContain(idToken)
  })
})

describe('[FR-LINE-001/AC3] a LIFF session stands on the LINE link it was opened with, and on no other', () => {
  it('names that link in its token (liff_<ChannelIdentity id>.<random>), and acts only as its member', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: linked.memberId, unlinkedAt: null } })
    const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const session = await liffSessionOf(linked.userId)
    expect(session!.token).toMatch(new RegExp(`^${LIFF_SESSION_TOKEN_PREFIX}${identity.id}\\.[A-Za-z0-9_-]{32}$`))
    expect(liffSessionIdentityId(session!.token)).toBe(identity.id)
    expect(await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', member: { id: linked.memberId } })
    // Anything else is no link: a web token, an unbound LIFF token, a link id spelled otherwise
    expect(liffSessionIdentityId(randomBytes(24).toString('hex'))).toBeNull()
    expect(liffSessionIdentityId(unboundLiffToken())).toBeNull()
    expect(liffSessionIdentityId(session!.token.replace(identity.id, identity.id.toUpperCase()))).toBeNull()
    expect(() => newLiffSessionToken('not-a-link')).toThrow(TypeError)
  })

  it('is refused and deleted once its link moved to another LINE account, though the member is linked again: on LIFF pages and on /get-session', async () => {
    for (const where of ['a LIFF page', '/get-session'] as const) {
      const orgId = await lineOrg()
      const linked = await linkedUser(orgId)
      const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
      const headers = new Headers({ cookie: r.cookie })
      expect((await betterAuth('/get-session', { method: 'GET', cookie: r.cookie })).body).toMatchObject({ user: { id: linked.userId } })
      // The link moves to the member's new phone: X's link ends and Y's is made, without anything ending the old session
      await prisma.channelIdentity.updateMany({ where: { organizationId: orgId, memberId: linked.memberId }, data: { unlinkedAt: new Date() } })
      await link(orgId, linked.memberId, newLineUserId())
      if (where === 'a LIFF page') {
        expect({ where, state: await resolveSession(headers, { channel: 'LIFF' }) }).toEqual({ where, state: { kind: 'anonymous' } })
      } else {
        // Better Auth's own read of the session finds none (and clears the cookie), as for a browser without one
        const read = await betterAuth('/get-session', { method: 'GET', cookie: r.cookie })
        expect({ where, status: read.status, body: read.body }).toEqual({ where, status: 200, body: null })
      }
      expect({ where, sessions: await sessionsOf(linked.userId) }).toEqual({ where, sessions: [] })
    }
  })

  it('a token that names no link — a session opened before sessions were bound — is refused and deleted, wherever it is seen', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const cases: Record<string, (cookie: string) => Promise<unknown>> = {
      'a LIFF page': (cookie) => resolveSession(new Headers({ cookie }), { channel: 'LIFF' }),
      'the workspace': (cookie) => resolveSession(new Headers({ cookie })),
      '/get-session': async (cookie) => (await betterAuth('/get-session', { method: 'GET', cookie })).body,
      '/sign-out': async (cookie) => (await betterAuth('/sign-out', { cookie })).status,
    }
    const answers: Record<string, unknown> = {}
    for (const [where, ask] of Object.entries(cases)) {
      const row = await sessionRow(linked.userId, unboundLiffToken())
      answers[where] = await ask(await signedCookieFor(row.token))
      expect({ where, left: await prisma.session.count({ where: { id: row.id } }) }).toEqual({ where, left: 0 })
    }
    expect(answers).toEqual({ 'a LIFF page': { kind: 'anonymous' }, 'the workspace': { kind: 'anonymous' }, '/get-session': null, '/sign-out': 200 })
    // A well-formed token that names a link of another member, or a link that is not there, stands for nobody either
    const someoneElse = await linkedUser(orgId)
    const theirs = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: someoneElse.memberId, unlinkedAt: null } })
    for (const identityId of [theirs.id, randomUUID()]) {
      const row = await sessionRow(linked.userId, newLiffSessionToken(identityId))
      expect(await resolveSession(new Headers({ cookie: await signedCookieFor(row.token) }), { channel: 'LIFF' })).toEqual({ kind: 'anonymous' })
      expect(await prisma.session.count({ where: { id: row.id } })).toBe(0)
    }
    expect(await sessionsOf(someoneElse.userId)).toEqual([])
  })

  it('one person linked with the same LINE account in two organizations: the session is the first member’s link’s, and ends with it', async () => {
    const first = await lineOrg()
    const second = await lineOrg()
    const email = `${randomUUID()}@test.bcs.local`
    const userId = await upsertUserWithPassword({ email, name: 'สองบริษัท', password: PASSWORD })
    // a joined first (the member resolveSession has always opened first for this person)
    const a = await prisma.member.create({ data: { organizationId: first, email, displayNameTh: 'สองบริษัท', status: 'ACTIVE', userId, createdAt: new Date(Date.now() - MS_PER_MINUTE) } })
    const b = await prisma.member.create({ data: { organizationId: second, email, displayNameTh: 'สองบริษัท', status: 'ACTIVE', userId } })
    const lineUserId = newLineUserId()
    const aLink = await link(first, a.id, lineUserId)
    const bLink = await link(second, b.id, lineUserId)
    const r = await liffSignIn({ idToken: tokenFor(lineUserId) })
    expect(liffSessionIdentityId((await liffSessionOf(userId))!.token)).toBe(aLink.id)
    // Asking for the other organization changes nothing: the session is one link's, so one member's
    expect(await resolveSession(new Headers({ cookie: `${r.cookie}; ${ORG_COOKIE}=${second}` }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', member: { id: a.id } })
    // Its link ends: the session ends with it, though the same LINE account is still linked in the other organization
    await prisma.channelIdentity.update({ where: { id: aLink.id }, data: { unlinkedAt: new Date() } })
    expect(await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'LIFF' })).toEqual({ kind: 'anonymous' })
    // A new sign-in stands on the link that is left
    const again = await liffSignIn({ idToken: tokenFor(lineUserId) })
    expect(liffSessionIdentityId((await liffSessionOf(userId))!.token)).toBe(bLink.id)
    expect(await resolveSession(new Headers({ cookie: again.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', member: { id: b.id } })
  })
})

describe('[FR-AUTH-003/AC1] a LINE sign-in never replaces a live session of another sign-in identity', () => {
  it('refuses it in a browser holding someone else’s session (password or LINE), which stays with its cookie; the refusal is recorded without the token', async () => {
    const orgId = await lineOrg()
    const a = await linkedUser(orgId)
    const b = await linkedUser(orgId)
    const since = new Date()
    const aWeb = await webSession(a.userId)
    const aWebCookie = await signedCookieFor(aWeb.token)
    const idToken = tokenFor(b.lineUserId)
    const refused = await liffSignIn({ idToken }, { cookie: aWebCookie })
    expect(refused).toMatchObject({ status: 403, body: { code: 'FORBIDDEN', reason: 'SIGNED_IN_AS_ANOTHER_USER' }, cookie: '' })
    expect(await prisma.session.findUnique({ where: { id: aWeb.id } })).toMatchObject({ token: aWeb.token })
    expect(await resolveSession(new Headers({ cookie: aWebCookie }))).toMatchObject({ kind: 'member', userId: a.userId })
    expect(await sessionsOf(b.userId)).toEqual([])

    // Someone else's LINE sign-in in this browser: the same
    const aLiff = await liffSignIn({ idToken: tokenFor(a.lineUserId) })
    expect(await liffSignIn({ idToken: tokenFor(b.lineUserId) }, { cookie: aLiff.cookie })).toMatchObject({ status: 403, body: { reason: 'SIGNED_IN_AS_ANOTHER_USER' }, cookie: '' })
    expect(await resolveSession(new Headers({ cookie: aLiff.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', userId: a.userId })
    expect(await sessionsOf(b.userId)).toEqual([])

    // Recorded as a failed LINE sign-in of b, with neither token nor LINE user id
    const failed = await prisma.event.findMany({ where: { type: 'auth.login_failed', channel: 'LIFF', aggregateId: b.memberId, occurredAt: { gte: since } } })
    expect(failed.map((e) => (e.data as { step?: string }).step)).toEqual(['liff', 'liff'])
    const recorded = JSON.stringify(failed.map((e) => e.data))
    expect(recorded).not.toContain(b.lineUserId)
    expect(recorded).not.toContain(idToken)
    expect(recorded).not.toContain(aWeb.token)
  })

  it('someone else’s session counts until its own limits: a password session for 30 idle minutes, a LINE session for 15 while its link stands', async () => {
    const orgId = await lineOrg()
    const a = await linkedUser(orgId)
    const b = await linkedUser(orgId)
    const aLink = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: a.memberId, unlinkedAt: null } })
    const now = Date.now()
    const ago = (minutes: number) => new Date(now - minutes * MS_PER_MINUTE)
    // Live by the limits resolveSession counts for each kind (the workspace keeps a password session 30 idle minutes)
    const live = {
      'a password session idle for 20 minutes': await sessionRow(a.userId, randomBytes(24).toString('hex'), { createdAt: ago(60), lastActiveAt: ago(20) }),
      'a password session nearly 12 hours old': await sessionRow(a.userId, randomBytes(24).toString('hex'), { createdAt: ago(12 * 60 - 10), lastActiveAt: ago(1) }),
      'a LINE session idle for 13 minutes': await sessionRow(a.userId, newLiffSessionToken(aLink.id), { createdAt: ago(60), lastActiveAt: ago(13) }),
    }
    for (const [what, row] of Object.entries(live)) {
      const r = await liffSignIn({ idToken: tokenFor(b.lineUserId) }, { cookie: await signedCookieFor(row.token) })
      const kept = await prisma.session.count({ where: { id: row.id, token: row.token } })
      expect({ what, status: r.status, reason: r.body?.reason, cookie: r.cookie, kept }).toEqual({ what, status: 403, reason: 'SIGNED_IN_AS_ANOTHER_USER', cookie: '', kept: 1 })
    }
    expect(await sessionsOf(b.userId)).toEqual([])
  })

  it('still replaces what the browser holds of the same identity, or a session that has ended — past its limits, or a LINE session whose link is gone — whoever’s it was', async () => {
    const orgId = await lineOrg()
    const a = await linkedUser(orgId)
    const b = await linkedUser(orgId)
    // b's own password session in b's LINE browser: replaced by b's LINE sign-in (holding the cookie is the right to end it)
    const bWeb = await webSession(b.userId)
    expect((await liffSignIn({ idToken: tokenFor(b.lineUserId) }, { cookie: await signedCookieFor(bWeb.token) })).status).toBe(200)
    expect(await prisma.session.findUnique({ where: { id: bWeb.id } })).toBeNull()
    // a's sessions that resolveSession would refuse and delete at their next request are no sign-in to keep
    const aLink = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: a.memberId, unlinkedAt: null } })
    const aOldLink = await link(orgId, a.memberId, newLineUserId(), { unlinked: true })
    const now = Date.now()
    const ago = (minutes: number) => new Date(now - minutes * MS_PER_MINUTE)
    const ended = {
      'a session past its 12 hours': await sessionRow(a.userId, randomBytes(24).toString('hex'), { createdAt: ago(13 * 60) }),
      'a password session idle for 30 minutes': await sessionRow(a.userId, randomBytes(24).toString('hex'), { createdAt: ago(60), lastActiveAt: ago(30) }),
      'a password session never used for 30 minutes': await sessionRow(a.userId, randomBytes(24).toString('hex'), { createdAt: ago(30) }),
      'a LINE session idle for 15 minutes': await sessionRow(a.userId, newLiffSessionToken(aLink.id), { createdAt: ago(60), lastActiveAt: ago(15) }),
      'a LINE session whose link ended': await sessionRow(a.userId, newLiffSessionToken(aOldLink.id), { createdAt: ago(3), lastActiveAt: ago(1) }),
    }
    for (const [what, row] of Object.entries(ended)) {
      const r = await liffSignIn({ idToken: tokenFor(b.lineUserId) }, { cookie: await signedCookieFor(row.token) })
      expect({ what, status: r.status, left: await prisma.session.count({ where: { id: row.id } }) }).toEqual({ what, status: 200, left: 0 })
      expect({ what, state: await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'LIFF' }) }).toMatchObject({ what, state: { kind: 'member', userId: b.userId } })
    }
  })
})

describe('[FR-AUTH-003/AC1] a request the page makes by itself (touch: false) is no activity of the session', () => {
  it('leaves lastActiveAt as it was, yet still refuses and deletes a session past its idle limit', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const web = await webSession(linked.userId)
    const headers = new Headers({ cookie: await signedCookieFor(web.token) })
    const start = web.createdAt.getTime()
    // A status poll every few minutes for nearly half an hour: the session answers, and its idle clock never moves
    for (let minute = 2; minute < 30; minute += 4) {
      expect(await resolveSession(headers, { now: new Date(start + minute * MS_PER_MINUTE), touch: false })).toMatchObject({ kind: 'member', sessionId: web.id })
    }
    expect((await prisma.session.findUniqueOrThrow({ where: { id: web.id } })).lastActiveAt).toBeNull()
    // 30 minutes after the last activity it is idle, polled or not: refused and deleted
    expect(await resolveSession(headers, { now: new Date(start + 30 * MS_PER_MINUTE), touch: false })).toEqual({ kind: 'expired' })
    expect(await prisma.session.count({ where: { id: web.id } })).toBe(0)
  })

  it('the LIFF idle limit and the absolute limit hold too; a request that is activity moves the clock, as before', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const r = await liffSignIn({ idToken: tokenFor(linked.lineUserId) })
    const headers = new Headers({ cookie: r.cookie })
    const session = (await liffSessionOf(linked.userId))!
    const start = session.createdAt.getTime()
    expect(await resolveSession(headers, { channel: 'LIFF', now: new Date(start + 10 * MS_PER_MINUTE), touch: false })).toMatchObject({ kind: 'member' })
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).lastActiveAt).toBeNull()
    // Activity at 10 minutes moves it, so 20 minutes is within the LIFF limit only thanks to that activity
    const at = new Date(start + 10 * MS_PER_MINUTE)
    expect(await resolveSession(headers, { channel: 'LIFF', now: at })).toMatchObject({ kind: 'member' })
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).lastActiveAt).toEqual(at)
    expect(await resolveSession(headers, { channel: 'LIFF', now: new Date(start + 20 * MS_PER_MINUTE), touch: false })).toMatchObject({ kind: 'member' })
    expect(await resolveSession(headers, { channel: 'LIFF', now: new Date(start + 25 * MS_PER_MINUTE), touch: false })).toEqual({ kind: 'expired' })
    expect(await sessionsOf(linked.userId)).toEqual([])

    // The absolute 12 hours, without touching
    const web = await webSession(linked.userId)
    const webHeaders = new Headers({ cookie: await signedCookieFor(web.token) })
    await prisma.session.update({ where: { id: web.id }, data: { lastActiveAt: new Date(web.createdAt.getTime() + 12 * MS_PER_HOUR - MS_PER_MINUTE) } })
    expect(await resolveSession(webHeaders, { now: new Date(web.createdAt.getTime() + 12 * MS_PER_HOUR), touch: false })).toEqual({ kind: 'expired' })
    expect(await prisma.session.count({ where: { id: web.id } })).toBe(0)
  })
})

describe('[FR-AUTH-003/AC3] the list of signed-in devices shows live sessions only', () => {
  it('leaves out sessions past the absolute or idle limit, and LIFF sessions whose link ended or that name none; keeps the current one', async () => {
    const orgId = await lineOrg()
    const linked = await linkedUser(orgId)
    const live = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: linked.memberId, unlinkedAt: null } })
    const ended = await link(orgId, linked.memberId, newLineUserId(), { unlinked: true })
    const now = new Date()
    const ago = (minutes: number) => new Date(now.getTime() - minutes * MS_PER_MINUTE)
    const web = () => randomBytes(24).toString('hex')
    const current = await sessionRow(linked.userId, web(), { createdAt: ago(5), lastActiveAt: ago(1) })
    const rows = {
      webActive: await sessionRow(linked.userId, web(), { createdAt: ago(60), lastActiveAt: ago(20) }),
      webIdle: await sessionRow(linked.userId, web(), { createdAt: ago(60), lastActiveAt: ago(31) }),
      webNeverUsedIdle: await sessionRow(linked.userId, web(), { createdAt: ago(45) }),
      webPastTwelveHours: await sessionRow(linked.userId, web(), { createdAt: ago(12 * 60 + 1), lastActiveAt: ago(2), expiresAt: new Date(now.getTime() + MS_PER_HOUR) }),
      webExpired: await sessionRow(linked.userId, web(), { createdAt: ago(10), expiresAt: ago(1) }),
      liffActive: await sessionRow(linked.userId, newLiffSessionToken(live.id), { createdAt: ago(30), lastActiveAt: ago(10) }),
      liffIdle: await sessionRow(linked.userId, newLiffSessionToken(live.id), { createdAt: ago(30), lastActiveAt: ago(16) }),
      liffLinkEnded: await sessionRow(linked.userId, newLiffSessionToken(ended.id), { createdAt: ago(3), lastActiveAt: ago(1) }),
      liffUnbound: await sessionRow(linked.userId, unboundLiffToken(), { createdAt: ago(3), lastActiveAt: ago(1) }),
    }
    const listed = await listMySessions(linked.userId, current.id, now)
    const names = Object.fromEntries(Object.entries(rows).map(([name, row]) => [row.id, name]))
    expect(listed.map((d) => (d.id === current.id ? 'current' : names[d.id])).sort()).toEqual(['current', 'liffActive', 'webActive'])
    expect(listed.filter((d) => d.current).map((d) => d.id)).toEqual([current.id])
    // Listing changes nothing: every row is still there for the session lookup or the clean-up to end
    expect(await prisma.session.count({ where: { userId: linked.userId } })).toBe(Object.keys(rows).length + 1)
  })
})
