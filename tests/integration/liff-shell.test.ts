import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as mockTokenRoute } from '@/app/api/liff/mock-token/route'
import { POST as liffSessionRoute } from '@/app/api/liff/session/route'
import { MS_PER_HOUR } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { endStaleLiffSession, isLiffSessionToken, LIFF_SESSION_TOKEN_PREFIX, liffSessionIdentityId, liffSessionMemberIds, setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { resolveSession } from '@/server/auth/session'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { deleteMemberLiffSessions } from '@/server/db/sql/identity'
import { forTenant } from '@/server/db/tenant'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { getMyLineLink, issueLineLinkCode, LINE_LINK_ATTEMPTS_MAX, linkLineAccount, unlinkMyLine } from '@/server/services/line-link'
import { linkThisLineAccount, listLiffAdministrators, liffFacts, unlinkLineInLiff, whichLineIsLinked } from '@/server/services/liff'
import { newLineUserId } from '../../scripts/line-simulate'
import { createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-06 · the server side of the LIFF shell (src/server/services/liff, the binding of a LIFF session to its link in
// src/server/auth/liff.ts, POST /api/liff/mock-token):
//  - /liff/help names the organization's administrators from data, to an active member of that organization only;
//  - FR-LINE-001 AC2: a member who signed in inside LIFF with e-mail, password and 2FA links the LINE account the page
//    was opened with — a code issued for them and spent at once with the LIFF ID token, the same path as a QR code;
//  - FR-LINE-001 AC3 from the LINE side: whether the member's link is to the LINE account of the page's own ID token,
//    and ending only the link the page showed (another LINE account's only after a password sign-in);
//  - a LIFF session never outlives the link it stood on: it stands on the very link it was opened with (its token names
//    it), an unlink — from LIFF or the web — ends the member's LIFF sessions in its transaction, and a LIFF page refuses
//    a session whose link ended even after the member linked another LINE account (an old phone, after the link moved);
//  - LIFF_MOCK: the mock route only changes where the ID token comes from (the fake LINE server); the sign-in with it is
//    the real one (POST /api/liff/session, LINE's verify endpoint, the link check). The link under the QR code of
//    /settings/line opens the LIFF page of this machine instead of LINE.

// This environment's LIFF app (ADR-024) and LIFF_MOCK, set before anything reads the environment
const ENV = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID, LIFF_MOCK: process.env.LIFF_MOCK }
  const values = { liffId: '1650000023-LiFfShElL', liffChannelId: '1650000023' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  process.env.LIFF_MOCK = '1'
  return { ...values, before }
})

const PROVIDER = '1650000021'
const PASSWORD = 'liff-shell-password-1'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000022',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: ENV.liffId,
  liffChannelId: ENV.liffChannelId,
}

const line = withFakeLine()
const realFetch = globalThis.fetch.bind(globalThis)
/** Requests to LINE (LINE_API_BASE_URL) go to the fake LINE server of this file */
const toFakeLine = (input: Parameters<typeof fetch>[0]) => String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url)

beforeAll(() => {
  setLiffVerification({ fetch: (input, init) => realFetch(toFakeLine(input), init) })
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => realFetch(typeof input === 'string' || input instanceof URL ? toFakeLine(input) : input, init))
})
afterAll(() => {
  vi.restoreAllMocks()
  setLiffVerification(null)
  for (const [name, value] of Object.entries(ENV.before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

async function person(orgId: string, options: { name?: string; nameEn?: string; roles?: Array<'ORG_ADMIN'>; status?: 'ACTIVE' | 'DEACTIVATED'; revoked?: boolean } = {}) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: options.name ?? 'ผู้ใช้ LIFF', password: PASSWORD })
  const member = await prisma.member.create({
    data: { organizationId: orgId, email, displayNameTh: options.name ?? 'ผู้ใช้ LIFF', displayNameEn: options.nameEn ?? null, status: options.status ?? 'ACTIVE', userId },
  })
  for (const role of options.roles ?? []) {
    await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: member.id, role, grantedAt: new Date(), ...(options.revoked ? { revokedAt: new Date() } : {}) } })
  }
  return {
    memberId: member.id,
    userId,
    email,
    ctx: (channel: Ctx['channel'] = 'LIFF') => makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: member.id }, channel, now: new Date() }),
  }
}

/** An organization whose ORG_ADMIN saved its LINE channel with this environment's LIFF app */
async function lineOrg(options: { active?: boolean } = {}) {
  const org = await createOrg()
  const admin = await person(org.id, { roles: ['ORG_ADMIN'] })
  const saved = await saveLineChannelSettings(admin.ctx('WEB'), { ...CHANNEL, active: options.active ?? true }, { idempotencyKey: randomUUID(), sender: null })
  if (!saved.ok) throw new Error(`channel not saved: ${saved.error.code}`)
  return org.id
}

const idTokenFor = (lineUserId: string, aud: string = ENV.liffChannelId) => line.fake.issueIdToken({ sub: lineUserId, aud })

describe('[§9.4] the LIFF help (“ช่องทางติดต่อผู้ดูแล”) names the organization’s administrators from data', () => {
  it('lists the active administrators of the member’s own organization by name only', async () => {
    const org = await createOrg()
    const other = await createOrg()
    await person(org.id, { name: 'อดิศร ดูแลระบบ', nameEn: 'Adisorn Admin', roles: ['ORG_ADMIN'] })
    await person(org.id, { name: 'บุษบา ดูแลร่วม', roles: ['ORG_ADMIN'] })
    await person(org.id, { name: 'ปิดใช้ ผู้ดูแลเดิม', roles: ['ORG_ADMIN'], status: 'DEACTIVATED' })
    await person(org.id, { name: 'ถอน สิทธิ์แล้ว', roles: ['ORG_ADMIN'], revoked: true })
    await person(other.id, { name: 'ผู้ดูแล องค์กรอื่น', roles: ['ORG_ADMIN'] })
    const member = await person(org.id, { name: 'สมาชิก ทั่วไป' })
    const listed = await listLiffAdministrators(member.ctx())
    expect(listed).toEqual({
      ok: true,
      data: [
        { nameTh: 'บุษบา ดูแลร่วม', nameEn: null },
        { nameTh: 'อดิศร ดูแลระบบ', nameEn: 'Adisorn Admin' },
      ],
    })
    // Names only: no e-mail, phone or id leaves the service
    expect(JSON.stringify(listed)).not.toContain('@test.bcs.local')
  })

  it('refuses anyone who is not an active member of that organization', async () => {
    const org = await createOrg()
    const other = await createOrg()
    await person(org.id, { name: 'อดิศร ดูแลระบบ', roles: ['ORG_ADMIN'] })
    const gone = await person(org.id, { status: 'DEACTIVATED' })
    const outsider = await person(other.id)
    const asOutsider = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: outsider.memberId }, channel: 'LIFF', now: new Date() })
    for (const [who, ctx] of [
      ['a deactivated member', gone.ctx()],
      ['a member of another organization', asOutsider],
      ['the system', systemCtx(org.id, new Date())],
    ] as const) {
      const refused = await listLiffAdministrators(ctx)
      expect(refused.ok, who).toBe(false)
      if (!refused.ok) expect(refused.error.code, who).toBe('FORBIDDEN')
    }
  })

  it('states the PIN and link-code rules from the rules themselves', () => {
    expect(liffFacts()).toEqual({ pinLength: 6, pinFailureLimit: 5, pinLockMinutes: 15, linkCodeMinutes: 10 })
  })
})

describe('[FR-LINE-001/AC2] a member signed in inside LIFF links the LINE account LIFF was opened with', () => {
  it('issues a code for the signed-in member and spends it with the ID token: linked on channel LIFF, welcomed in LINE', async () => {
    const orgId = await lineOrg()
    const member = await person(orgId)
    const lineUserId = newLineUserId()
    const linked = await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId) }, { sender: null })
    expect(linked).toEqual({ ok: true, data: { linked: true } })
    const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: member.memberId, channel: 'LINE', unlinkedAt: null } })
    expect(identity).toMatchObject({ organizationId: orgId, providerKey: PROVIDER, externalUserId: lineUserId })
    // The code was spent once, for this member
    expect(await prisma.channelLinkCode.count({ where: { organizationId: orgId, memberId: member.memberId } })).toBe(1)
    const event = await prisma.event.findFirstOrThrow({ where: { type: 'line.linked', aggregateId: identity.id } })
    expect(event).toMatchObject({ organizationId: orgId, actorType: 'USER', actorMemberId: member.memberId, channel: 'LIFF' })
    expect(line.fake.messages().some((m) => m.kind === 'push' && m.to === lineUserId)).toBe(true)
    expect(await getMyLineLink(member.ctx())).toMatchObject({ ok: true, data: { linked: true } })
    // The same member again, and another member with the same LINE account
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId) }, { sender: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_LINKED' } },
    })
    const second = await person(orgId)
    expect(await linkThisLineAccount(second.ctx(), { idToken: idTokenFor(lineUserId) }, { sender: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER' } },
    })
  })

  it('links nothing with an ID token LINE does not accept for this LIFF channel, or a body that is not { idToken }', async () => {
    const orgId = await lineOrg()
    const member = await person(orgId)
    const lineUserId = newLineUserId()
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId, '1659999999') }, { sender: null })).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED', details: { reason: 'ID_TOKEN_INVALID' } },
    })
    expect(await linkThisLineAccount(member.ctx(), { idToken: 'not-a-token' }, { sender: null })).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } })
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId), lineUserId }, { sender: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await linkThisLineAccount(member.ctx(), {}, { sender: null })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'idToken' } } })
    expect(await prisma.channelIdentity.count({ where: { memberId: member.memberId } })).toBe(0)
  })

  it('refuses a member who is not active, the system, and an organization without LINE', async () => {
    const orgId = await lineOrg()
    const gone = await person(orgId, { status: 'DEACTIVATED' })
    const lineUserId = newLineUserId()
    for (const [who, ctx] of [
      ['a deactivated member', gone.ctx()],
      ['the system', systemCtx(orgId, new Date())],
    ] as const) {
      const refused = await linkThisLineAccount(ctx, { idToken: idTokenFor(lineUserId) }, { sender: null })
      expect(refused.ok, who).toBe(false)
      if (!refused.ok) expect(refused.error.code, who).toBe('FORBIDDEN')
    }
    const off = await lineOrg({ active: false })
    const member = await person(off)
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId) }, { sender: null })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'LINE_NOT_ENABLED' } },
    })
    expect(await prisma.channelIdentity.count({ where: { externalUserId: lineUserId } })).toBe(0)
  })
})

/** POST to a route as a page of this site does */
function fromThisSite(path: string, body: unknown): Request {
  const env = getEnv()
  return new Request(`${env.APP_URL.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    body: JSON.stringify(body),
  })
}

describe('[BR-LINE-01] with LIFF_MOCK only the source of the ID token changes; the sign-in is the real one', () => {
  it('a mock token of the fake LINE server opens a LIFF session for a linked LINE user, and LINK_REQUIRED for another', async () => {
    const orgId = await lineOrg()
    const member = await person(orgId)
    const lineUserId = newLineUserId()
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId) }, { sender: null })).toMatchObject({ ok: true })

    const issued = await mockTokenRoute(fromThisSite('/api/liff/mock-token', { lineUserId }))
    expect(issued.status).toBe(200)
    const { idToken } = (await issued.json()) as { idToken: string }
    expect(typeof idToken).toBe('string')
    const signedIn = await liffSessionRoute(fromThisSite('/api/liff/session', { idToken }))
    expect(signedIn.status).toBe(200)
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .filter((c) => c.includes('session_token=') && !c.endsWith('='))
      .join('; ')
    expect(await resolveSession(new Headers({ cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', member: { id: member.memberId, organizationId: orgId } })

    const stranger = await mockTokenRoute(fromThisSite('/api/liff/mock-token', { lineUserId: newLineUserId() }))
    const refused = await liffSessionRoute(fromThisSite('/api/liff/session', { idToken: ((await stranger.json()) as { idToken: string }).idToken }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'FORBIDDEN', reason: 'LINK_REQUIRED' })
  })
})

/** Calls BCS made to LINE's verify endpoint so far */
const verifyCalls = () => line.fake.requests().filter((r) => r.route === '/oauth2/v2.1/verify').length

/** A member of a LINE organization linked to a LINE account of their own */
async function linkedMember() {
  const orgId = await lineOrg()
  const member = await person(orgId)
  const lineUserId = newLineUserId()
  expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(lineUserId) }, { sender: null })).toMatchObject({ ok: true })
  const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: member.memberId, unlinkedAt: null } })
  return { orgId, member, lineUserId, identityId: identity.id }
}

describe('[FR-LINE-001/AC3] /liff/link tells this LINE account from another one by the page’s own ID token', () => {
  it('answers this, other or none from the token LINE verified, never from the member’s link alone', async () => {
    const orgId = await lineOrg()
    const member = await person(orgId)
    const y = newLineUserId()
    const x = newLineUserId()
    // Not linked: nothing to compare, LINE is not asked
    const before = verifyCalls()
    expect(await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(y) })).toEqual({ ok: true, data: { link: 'none' } })
    expect(verifyCalls()).toBe(before)
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(y) }, { sender: null })).toMatchObject({ ok: true })
    expect(await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(y) })).toEqual({ ok: true, data: { link: 'this' } })
    // The same member signed in with a password in another LINE app: linked, but not to this one
    expect(await whichLineIsLinked(member.ctx('WEB'), { idToken: idTokenFor(x) })).toEqual({ ok: true, data: { link: 'other' } })
    // Nothing the browser says about the LINE user is read: only { idToken }, and only a token LINE accepts
    expect(await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(y), lineUserId: y })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(y, '1659999999') })).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED', details: { reason: 'ID_TOKEN_INVALID' } },
    })
  })

  it('refuses anyone who is not an active member of the organization, before asking LINE', async () => {
    const { orgId, lineUserId } = await linkedMember()
    const gone = await person(orgId, { status: 'DEACTIVATED' })
    const other = await createOrg()
    const outsider = await person(other.id)
    const asOutsider = makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: outsider.memberId }, channel: 'LIFF', now: new Date() })
    const before = verifyCalls()
    for (const [who, ctx] of [
      ['a deactivated member', gone.ctx()],
      ['a member of another organization', asOutsider],
      ['the system', systemCtx(orgId, new Date())],
    ] as const) {
      const refused = await whichLineIsLinked(ctx, { idToken: idTokenFor(lineUserId) })
      expect(refused.ok, who).toBe(false)
      if (!refused.ok) expect(refused.error.code, who).toBe('FORBIDDEN')
      const unlink = await unlinkLineInLiff(ctx, { idToken: idTokenFor(lineUserId), which: 'this' }, { idempotencyKey: randomUUID(), signIn: 'liff' })
      expect(unlink.ok, who).toBe(false)
      if (!unlink.ok) expect(unlink.error.code, who).toBe('FORBIDDEN')
    }
    expect(verifyCalls()).toBe(before)
  })

  it('counts a member’s checks: past the limit within the window, RATE_LIMITED with a time, and LINE is not asked', async () => {
    const { member, lineUserId } = await linkedMember()
    const now = new Date()
    for (let i = 0; i < LINE_LINK_ATTEMPTS_MAX; i++) {
      expect(await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(lineUserId) }, { now })).toMatchObject({ ok: true, data: { link: 'this' } })
    }
    const before = verifyCalls()
    const limited = await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(lineUserId) }, { now })
    expect(limited).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'LINE_CHECKS' } } })
    if (!limited.ok) expect(new Date(String(limited.error.details?.time)).getTime()).toBeGreaterThan(now.getTime())
    expect(verifyCalls()).toBe(before)
  })
})

describe('[FR-LINE-001/AC3] unlinking from LIFF ends only the link the page showed', () => {
  it('"this": ends the link of the LINE account the page is open in, with Event line.unlinked on channel LIFF', async () => {
    const { orgId, member, lineUserId, identityId } = await linkedMember()
    const ended = await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(lineUserId), which: 'this' }, { idempotencyKey: randomUUID(), signIn: 'liff' })
    expect(ended).toEqual({ ok: true, data: { unlinked: true } })
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).not.toBeNull()
    const event = await prisma.event.findFirstOrThrow({ where: { type: 'line.unlinked', aggregateId: identityId } })
    expect(event).toMatchObject({ organizationId: orgId, actorType: 'USER', actorMemberId: member.memberId, channel: 'LIFF' })
    // Nothing left to end
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(lineUserId), which: 'this' }, { idempotencyKey: randomUUID(), signIn: 'liff' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_LINKED' } },
    })
  })

  it('"this" from another LINE app ends nothing: the page showed a link that is not there', async () => {
    const { member, identityId } = await linkedMember()
    const refused = await unlinkLineInLiff(member.ctx('WEB'), { idToken: idTokenFor(newLineUserId()), which: 'this' }, { idempotencyKey: randomUUID(), signIn: 'web' })
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'LINK_CHANGED' } } })
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).toBeNull()
  })

  it('"other" needs the password sign-in; with it, the other link ends and this LINE account can be linked', async () => {
    const { member, lineUserId, identityId } = await linkedMember()
    const x = newLineUserId()
    // A session opened with LINE alone stands for its own LINE account, not for another one
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(x), which: 'other' }, { idempotencyKey: randomUUID(), signIn: 'liff' })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN', details: { reason: 'PASSWORD_SIGN_IN_REQUIRED' } },
    })
    // "other" from the very LINE account that is linked: that is not the other one
    expect(await unlinkLineInLiff(member.ctx('WEB'), { idToken: idTokenFor(lineUserId), which: 'other' }, { idempotencyKey: randomUUID(), signIn: 'web' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'LINK_CHANGED' } },
    })
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).toBeNull()
    // Signed in with a password in the new phone's LINE app: end the old link, then link this one
    expect(await unlinkLineInLiff(member.ctx('WEB'), { idToken: idTokenFor(x), which: 'other' }, { idempotencyKey: randomUUID(), signIn: 'web' })).toEqual({
      ok: true,
      data: { unlinked: true },
    })
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).not.toBeNull()
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(x) }, { sender: null })).toMatchObject({ ok: true })
    expect(await whichLineIsLinked(member.ctx(), { idToken: idTokenFor(x) })).toEqual({ ok: true, data: { link: 'this' } })
  })

  it('takes { idToken, which } and an idempotency key, nothing else', async () => {
    const { member, lineUserId, identityId } = await linkedMember()
    const options = { idempotencyKey: randomUUID(), signIn: 'liff' } as const
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(lineUserId), which: 'both' }, options)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(lineUserId), which: 'this', identityId }, options)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(lineUserId), which: 'this' }, { ...options, idempotencyKey: '' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'idempotencyKey' } },
    })
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).toBeNull()
  })
})

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => c.includes('session_token=') && !c.endsWith('='))
    .join('; ')

/** A LIFF session of this LINE account, opened as the LIFF page opens it (POST /api/liff/session): its cookie */
async function liffSessionOf(lineUserId: string): Promise<string> {
  const response = await liffSessionRoute(fromThisSite('/api/liff/session', { idToken: idTokenFor(lineUserId) }))
  expect(response.status).toBe(200)
  return cookieOf(response)
}

/** A password sign-in (Better Auth's own endpoint, as /login sends it): its cookie */
async function passwordSessionOf(email: string): Promise<string> {
  const env = getEnv()
  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  )
  expect(response.status).toBe(200)
  return cookieOf(response)
}

const asLiffPage = (cookie: string) => resolveSession(new Headers({ cookie }), { channel: 'LIFF' })

/** The LIFF sessions of a sign-in identity still on record */
const liffSessionsOf = async (userId: string) =>
  // The prefix is checked here, not with Prisma's startsWith, which leaves the `_` of liff_ a LIKE wildcard
  (await prisma.session.findMany({ where: { userId }, select: { id: true, token: true }, orderBy: { createdAt: 'asc' } })).filter((s) => isLiffSessionToken(s.token)).map((s) => ({ id: s.id }))

describe('[FR-LINE-001/AC3] a link ended from LIFF takes the LIFF sessions of the member with it', () => {
  it('moving the link to a new phone signs the old phone out at once; the new phone keeps its password sign-in', async () => {
    const { member, lineUserId: x } = await linkedMember()
    const oldPhone = await liffSessionOf(x)
    expect(await asLiffPage(oldPhone)).toMatchObject({ kind: 'member', member: { id: member.memberId } })
    // The new phone: a password sign-in in its LINE app, end the old link, link this one
    const newPhone = await passwordSessionOf(member.email)
    const y = newLineUserId()
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(y), which: 'other' }, { idempotencyKey: randomUUID(), signIn: 'web' })).toEqual({
      ok: true,
      data: { unlinked: true },
    })
    expect(await liffSessionsOf(member.userId)).toEqual([])
    expect(await linkThisLineAccount(member.ctx(), { idToken: idTokenFor(y) }, { sender: null })).toMatchObject({ ok: true })
    // The member has a live link again, and still the old phone's cookie opens nothing
    expect(await asLiffPage(oldPhone)).toEqual({ kind: 'anonymous' })
    expect(await asLiffPage(newPhone)).toMatchObject({ kind: 'member', member: { id: member.memberId } })
    // The new LINE account signs in by itself from now on; the old one cannot
    expect(await asLiffPage(await liffSessionOf(y))).toMatchObject({ kind: 'member', member: { id: member.memberId } })
    expect((await liffSessionRoute(fromThisSite('/api/liff/session', { idToken: idTokenFor(x) }))).status).toBe(403)
  })

  it('"this": a session of the LINE app that unlinked does not come back when the same LINE account is linked again', async () => {
    const { member, lineUserId } = await linkedMember()
    const phone = await liffSessionOf(lineUserId)
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(lineUserId), which: 'this' }, { idempotencyKey: randomUUID(), signIn: 'liff' })).toMatchObject({ ok: true })
    // Linked again at once (a QR code from the web settings), before the phone made any request
    const issued = await issueLineLinkCode(member.ctx('WEB'))
    if (!issued.ok) throw new Error(issued.error.code)
    expect(await linkLineAccount({ code: issued.data.code, idToken: idTokenFor(lineUserId) }, { sender: null })).toMatchObject({ ok: true })
    expect(await asLiffPage(phone)).toEqual({ kind: 'anonymous' })
  })

  it('ends only the LIFF sessions of that member’s sign-in identity: their password session and another member’s LIFF session stay', async () => {
    const a = await linkedMember()
    const b = await linkedMember()
    const aLiff = await liffSessionOf(a.lineUserId)
    const aWeb = await passwordSessionOf(a.member.email)
    const bLiff = await liffSessionOf(b.lineUserId)
    // A password session whose token happens to begin with "liff" and another character is no LIFF session (LIKE 'liff\_%')
    const lookalike = await prisma.session.create({ data: { id: randomUUID(), userId: a.member.userId, token: `liffA${randomUUID().replace(/-/g, '')}`, expiresAt: new Date(Date.now() + MS_PER_HOUR) } })
    expect(await unlinkMyLine(a.member.ctx('WEB'), {}, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: true })
    expect(await liffSessionsOf(a.member.userId)).toEqual([])
    expect(await asLiffPage(aLiff)).toEqual({ kind: 'anonymous' })
    expect(await asLiffPage(aWeb)).toMatchObject({ kind: 'member', member: { id: a.member.memberId } })
    expect(await prisma.session.count({ where: { id: lookalike.id } })).toBe(1)
    expect(await asLiffPage(bLiff)).toMatchObject({ kind: 'member', member: { id: b.member.memberId } })
    // The helper reaches the identity of a member of the given organization only: a member of another one is nobody here
    expect(await forTenant(b.orgId).$transaction((tx) => deleteMemberLiffSessions(tx, b.orgId, a.member.memberId))).toBe(0)
    expect(await liffSessionsOf(b.member.userId)).toHaveLength(1)
  })
})

describe('[FR-LINE-001/AC3] a LIFF session stands on the link it was opened with, and on no other', () => {
  it('names that link in its token: liff_<ChannelIdentity id>.<32 random characters>', async () => {
    const { member, identityId, lineUserId } = await linkedMember()
    await liffSessionOf(lineUserId)
    const [row] = await prisma.session.findMany({ where: { userId: member.userId, token: { startsWith: LIFF_SESSION_TOKEN_PREFIX } }, select: { token: true } })
    expect(row!.token).toMatch(new RegExp(`^liff_${identityId}\\.[A-Za-z0-9_-]{32}$`))
    expect(liffSessionIdentityId(row!.token)).toBe(identityId)
  })

  it('unlinked on the web and linked again from another phone: the old phone’s session is refused and ended, even one the unlink missed', async () => {
    const { member, lineUserId: x } = await linkedMember()
    const oldPhone = await liffSessionOf(x)
    const [opened] = await prisma.session.findMany({ where: { userId: member.userId, token: { startsWith: LIFF_SESSION_TOKEN_PREFIX } } })
    // /settings/line ends the link (no LIFF page is involved): the old phone's session ends in the same transaction
    expect(await unlinkMyLine(member.ctx('WEB'), {}, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: true })
    expect(await liffSessionsOf(member.userId)).toEqual([])
    // Written back as if the unlink had missed it (a backup, a race), then a QR code from the new phone links Y
    await prisma.session.create({ data: { ...opened!, lastActiveAt: new Date() } })
    const issued = await issueLineLinkCode(member.ctx('WEB'))
    if (!issued.ok) throw new Error(issued.error.code)
    expect(await linkLineAccount({ code: issued.data.code, idToken: idTokenFor(newLineUserId()) }, { sender: null })).toMatchObject({ ok: true })
    // The binding checked on every request refuses it: it names link X, which ended. Better Auth's endpoints that a LIFF
    // session may reach end it (endStaleLiffSession), and so does the session lookup of every LIFF page
    expect(await liffSessionMemberIds(member.userId, opened!.token)).toEqual(new Set())
    expect(await endStaleLiffSession(opened!.token)).toBe(false)
    expect(await prisma.session.count({ where: { id: opened!.id } })).toBe(0)
    await prisma.session.create({ data: { ...opened!, lastActiveAt: new Date() } })
    expect(await asLiffPage(oldPhone)).toEqual({ kind: 'anonymous' })
    expect(await prisma.session.count({ where: { id: opened!.id } })).toBe(0)
  })

  it('moved through LIFF and back to the same LINE account: the session of the earlier link stays refused', async () => {
    const { member, lineUserId: x } = await linkedMember()
    const phone = await liffSessionOf(x)
    const [opened] = await prisma.session.findMany({ where: { userId: member.userId, token: { startsWith: LIFF_SESSION_TOKEN_PREFIX } } })
    expect(await unlinkLineInLiff(member.ctx(), { idToken: idTokenFor(x), which: 'this' }, { idempotencyKey: randomUUID(), signIn: 'liff' })).toMatchObject({ ok: true })
    expect(await linkThisLineAccount(member.ctx('WEB'), { idToken: idTokenFor(x) }, { sender: null })).toMatchObject({ ok: true })
    // The same LINE account is linked again, as a new link: a session of the earlier one is not a session of this one
    await prisma.session.create({ data: { ...opened!, lastActiveAt: new Date() } })
    expect(await liffSessionMemberIds(member.userId, opened!.token)).toEqual(new Set())
    expect(await endStaleLiffSession(opened!.token)).toBe(false)
    await prisma.session.create({ data: { ...opened!, lastActiveAt: new Date() } })
    expect(await asLiffPage(phone)).toEqual({ kind: 'anonymous' })
    // A sign-in now stands on the new link
    expect(await asLiffPage(await liffSessionOf(x))).toMatchObject({ kind: 'member', member: { id: member.memberId } })
  })

  it('accepts a LIFF session of the member’s live link, and never refuses a password session for it', async () => {
    const { member, lineUserId: x } = await linkedMember()
    const web = await passwordSessionOf(member.email)
    expect(await unlinkMyLine(member.ctx('WEB'), {}, { idempotencyKey: randomUUID(), sender: null })).toMatchObject({ ok: true })
    const issued = await issueLineLinkCode(member.ctx('WEB'))
    if (!issued.ok) throw new Error(issued.error.code)
    expect(await linkLineAccount({ code: issued.data.code, idToken: idTokenFor(x) }, { sender: null })).toMatchObject({ ok: true })
    const fresh = await liffSessionOf(x)
    const freshState = await asLiffPage(fresh)
    const webState = await asLiffPage(web)
    if (freshState.kind !== 'member' || webState.kind !== 'member') throw new Error('both sessions should open LIFF pages')
    expect(freshState.member.id).toBe(member.memberId)
    expect(webState.member.id).toBe(member.memberId)
    // The binding checked on every request: the LIFF session stands on the live link, as its member (a password session
    // has no link to stand on, and nothing of this is asked of it)
    const { token } = await prisma.session.findUniqueOrThrow({ where: { id: freshState.sessionId }, select: { token: true } })
    expect(await liffSessionMemberIds(member.userId, token)).toEqual(new Set([member.memberId]))
    expect(await endStaleLiffSession(token)).toBe(true)
    // Asked again, both still stand: nothing was ended on the way
    expect(await asLiffPage(fresh)).toMatchObject({ kind: 'member' })
    expect(await asLiffPage(web)).toMatchObject({ kind: 'member' })
  })
})

describe('[FR-LINE-001/AC1] with LIFF_MOCK the link under the QR code of /settings/line opens the LIFF page of this machine', () => {
  it('gives the local /liff/link?code=… of APP_URL, said to be local, instead of LINE’s address', async () => {
    const orgId = await lineOrg()
    const member = await person(orgId)
    const issued = await issueLineLinkCode(member.ctx('WEB'))
    if (!issued.ok) throw new Error(issued.error.code)
    expect(issued.data.url).toBe(`${getEnv().APP_URL.replace(/\/+$/, '')}/liff/link?code=${encodeURIComponent(issued.data.code)}`)
    expect(issued.data.local).toBe(true)
    expect(issued.data.url).not.toContain('liff.line.me')
    // The code itself is the same kind of code: it links from that page as from LINE
    expect(await linkLineAccount({ code: issued.data.code, idToken: idTokenFor(newLineUserId()) }, { sender: null })).toMatchObject({ ok: true })
  })
})
