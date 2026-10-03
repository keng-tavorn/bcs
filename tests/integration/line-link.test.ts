import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as linkRoute } from '@/app/api/liff/link/route'
import { POST as liffSessionRoute } from '@/app/api/liff/session/route'
import { POST as webhookRoute } from '@/app/api/webhooks/line/[channelKey]/route'
import type { Result } from '@/core/result'
import { setLineClient } from '@/integrations/line'
import { MS_PER_HOUR, MS_PER_MINUTE, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { totp } from '@/lib/totp'
import { auth } from '@/server/auth/auth'
import { findLiffLinkedUser, liffSessionMemberIds, setLiffVerification } from '@/server/auth/liff'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { ctxFromSession, resolveSession } from '@/server/auth/session'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { getDefaultOutboxSender, setDefaultOutboxSender, type OutboxMessage, type OutboxSender } from '@/server/events/outbox'
import { lineRichMenuRun } from '@/server/jobs/line-rich-menu'
import { LINE_LINK_CODE_TTL_MS, lineLinkCodeHash } from '@/server/line/link-code'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import {
  getMyLineLink,
  issueLineLinkCode,
  LINE_LINK_ATTEMPTS_MAX,
  linkLineAccount,
  previewLineLinkCode,
  readLineRichMenuImages,
  replaceLineRichMenus,
  unlinkMyLine,
  type LineRichMenuImages,
} from '@/server/services/line-link'
import { deactivateMember } from '@/server/services/members'
import { registerDeactivationRevoker } from '@/server/services/members/revokers'
import { buildLineWebhook, lineEvents, newLineUserId, signLineWebhook, type LineWebhookEventJson } from '../../scripts/line-simulate'
import { startFakeLine, type FakeLine } from '../../scripts/lib/fake-line'
import { createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-04 · FR-LINE-001: linking a member's LINE account (§9.2 steps 1 to 4). A member signed in to the workspace gets a
// one-time code (10 minutes) as the QR or link of the LIFF page /liff/link?code=…; the LIFF page shows whose account the
// code links (a read-only preview) and, on the person's tap, posts { code, idToken } to POST /api/liff/link; LINE's
// verify endpoint (here the fake LINE server of the repo, which verifies only tokens it issued) checks the ID token
// (BR-LINE-02), the code is spent once, the ChannelIdentity is made, the LINKED rich menu is linked to the LINE user at
// once and a welcome message is pushed. Starting from LINE, the LIFF page signs in with e-mail, password and 2FA first
// and goes on the same way (AC2). One LINE account per member of an organization and one per member; unlinking from the
// workspace or from LINE in the LIFF app (the chat has no unlink button); deactivating a member unlinks in the same
// transaction (AC3, FR-AUTH-003 AC2).

// The LIFF app of this test environment (ADR-024: one per environment), set before anything reads the environment
const ENV = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID }
  const values = { liffId: '1650000013-LnKtEsTs', liffChannelId: '1650000013' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  return { ...values, before }
})

const PROVIDER = '1650000011'
const PASSWORD = 'line-link-password-1'
const TOTP_SECRET = 'L'.repeat(32)
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000012',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: ENV.liffId,
  liffChannelId: ENV.liffChannelId,
}
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

const line = withFakeLine()
/** Another LINE server: its tokens look right but the LINE the app asks never issued them */
let elsewhere: FakeLine
let images: LineRichMenuImages
/** Requests the app sent to LINE's verify endpoint */
let verifyCalls = 0
let lineDown = false
/** What the commands handed to Inngest (the default outbox sender is replaced for this file) */
const toInngest: OutboxMessage[] = []
let senderBefore: OutboxSender | null = null

beforeAll(async () => {
  elsewhere = await startFakeLine({ port: 0, channelSecret: TEST_CHANNEL_SECRET })
  images = await readLineRichMenuImages()
  // LINE's verify endpoint is the fake's; the channel the token is checked for is the environment's (no override)
  setLiffVerification({
    fetch: async (input, init) => {
      verifyCalls++
      if (lineDown) return new Response('upstream error', { status: 503 })
      return fetch(String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url), init)
    },
  })
  senderBefore = getDefaultOutboxSender()
  setDefaultOutboxSender(async (messages) => {
    toInngest.push(...messages)
  })
})
afterAll(async () => {
  setLiffVerification(null)
  setDefaultOutboxSender(senderBefore)
  await elsewhere.close()
  for (const [name, value] of Object.entries(ENV.before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.data
}

/** An organization whose ORG_ADMIN saved its LINE channel (this environment's LIFF app) and made both rich menus */
async function lineOrg(options: { active?: boolean; liffChannelId?: string; menus?: boolean } = {}) {
  const org = await createOrg()
  const admin = await person(org.id, { roles: ['ORG_ADMIN'] })
  const adminCtx = admin.ctx()
  const liff = options.liffChannelId ? { liffId: `${options.liffChannelId}-OtHeRaPp`, liffChannelId: options.liffChannelId } : {}
  const saved = ok(await saveLineChannelSettings(adminCtx, { ...CHANNEL, ...liff, active: options.active ?? true }, key()))
  let linkedMenu: string | null = null
  let unlinkedMenu: string | null = null
  if (options.menus !== false) {
    const menus = ok(await replaceLineRichMenus(adminCtx, images, key()))
    linkedMenu = menus.linkedId
    unlinkedMenu = menus.unlinkedId
  }
  return { orgId: org.id, code: org.code, admin, adminCtx, channelKey: saved.channelKey, linkedMenu, unlinkedMenu }
}

/** A member with a sign-in identity (password; an authenticator when asked) */
async function person(orgId: string, options: { roles?: Array<'ORG_ADMIN' | 'FINANCE'>; totpSecret?: string } = {}) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ LINE', password: PASSWORD })
  const member = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้ LINE', status: 'ACTIVE', userId } })
  for (const role of options.roles ?? []) await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: member.id, role, grantedAt: new Date() } })
  if (options.totpSecret) await enableTotpWithSecret(userId, options.totpSecret, [])
  return {
    memberId: member.id,
    userId,
    email,
    ctx: (channel: Ctx['channel'] = 'WEB', now: Date = new Date()) => makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: member.id }, channel, now }),
  }
}
type Person = Awaited<ReturnType<typeof person>>

const idTokenFor = (lineUserId: string, extra: { aud?: string; expiresInSeconds?: number } = {}) =>
  line.fake.issueIdToken({ sub: lineUserId, aud: extra.aud ?? ENV.liffChannelId, ...(extra.expiresInSeconds === undefined ? {} : { expiresInSeconds: extra.expiresInSeconds }) })

/** POST /api/liff/link as the LIFF page sends it (same origin) */
async function postLink(body: unknown, options: { origin?: string; headers?: Record<string, string> } = {}) {
  const env = getEnv()
  const response = await linkRoute(
    new Request(`${env.APP_URL.replace(/\/+$/, '')}/api/liff/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: options.origin ?? new URL(env.APP_URL).origin, ...options.headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null }
}

async function codeOf(p: Person, now?: Date) {
  return ok(await issueLineLinkCode(p.ctx(), now))
}

/** Links through the whole path: the code, then the LIFF page's request */
async function linkVia(p: Person, lineUserId: string = newLineUserId()) {
  const code = await codeOf(p)
  const answer = await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })
  expect(answer).toEqual({ status: 200, body: { ok: true } })
  const identity = await prisma.channelIdentity.findFirstOrThrow({ where: { memberId: p.memberId, unlinkedAt: null } })
  return { lineUserId, identityId: identity.id }
}

const liveLinks = (orgId: string) => prisma.channelIdentity.findMany({ where: { organizationId: orgId, unlinkedAt: null }, orderBy: { linkedAt: 'asc' } })
const eventsOf = (orgId: string, type: string) => prisma.event.findMany({ where: { organizationId: orgId, type }, orderBy: { seq: 'asc' } })
/** The menu linked to the user; null means the account's default (UNLINKED) shows */
const menuOf = (lineUserId: string) => line.fake.userRichMenu(lineUserId)
const pushesTo = (lineUserId: string) => line.fake.messages().filter((m) => m.kind === 'push' && m.to === lineUserId)
const repliesTo = (event: LineWebhookEventJson) => line.fake.messages().filter((m) => m.kind === 'reply' && m.replyToken === event.replyToken)
const jobStep = { run: <T>(_id: string, fn: () => Promise<T>) => fn() }

/** A webhook signed as LINE signs it, to the app's route */
async function deliver(channelKey: string, events: readonly LineWebhookEventJson[]): Promise<number> {
  const { body } = buildLineWebhook(events)
  const response = await webhookRoute(
    new Request(`http://localhost:3000/api/webhooks/line/${channelKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'LineBotWebhook/2.0', 'x-line-signature': signLineWebhook(TEST_CHANNEL_SECRET, body) },
      body,
    }),
    { params: Promise.resolve({ channelKey }) },
  )
  return response.status
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const until = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || performance.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// ---------- a code changed by hand ----------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const partsOf = (code: string) => code.split('.')
const withPart = (code: string, index: number, value: string) => partsOf(code).map((p, i) => (i === index ? value : p)).join('.')
/** The same bytes spelled another way: the last character's unused low bit set */
const respelled = (part: string) => part.slice(0, -1) + ALPHABET[ALPHABET.indexOf(part.at(-1)!) ^ 1]!
const uuidPart = (uuid: string) => Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url')

describe('[FR-LINE-001/AC1] a member signed in to the workspace gets a one-time code for 10 minutes, opens it in LINE and is linked; the rich menu becomes LINKED', () => {
  it('links: the code as the LIFF link, the ID token LINE verified, a ChannelIdentity under the provider, line.linked, the LINKED menu at once and a welcome message', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const issuedAt = new Date()
    const code = await codeOf(member, issuedAt)
    expect(code.url).toBe(`https://liff.line.me/${ENV.liffId}/link?code=${encodeURIComponent(code.code)}`)
    expect(new Date(code.expiresAt).getTime() - issuedAt.getTime()).toBe(10 * MS_PER_MINUTE)
    // Issuing writes nothing: the code is signed, and only its hash is kept once it is used
    expect(await prisma.channelLinkCode.count({ where: { organizationId: org.orgId } })).toBe(0)

    const lineUserId = newLineUserId()
    const calls = verifyCalls
    expect(await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })).toEqual({ status: 200, body: { ok: true } })
    expect(verifyCalls).toBe(calls + 1)

    const [identity, ...more] = await liveLinks(org.orgId)
    expect(more).toEqual([])
    expect(identity).toMatchObject({ memberId: member.memberId, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, unlinkedAt: null })
    const spent = await prisma.channelLinkCode.findMany({ where: { organizationId: org.orgId } })
    expect(spent).toEqual([expect.objectContaining({ memberId: member.memberId, codeHash: lineLinkCodeHash(code.code), expiresAt: new Date(code.expiresAt), usedAt: identity!.linkedAt })])
    const linked = await eventsOf(org.orgId, 'line.linked')
    expect(linked).toEqual([
      expect.objectContaining({ aggregateType: 'ChannelIdentity', aggregateId: identity!.id, channel: 'LIFF', actorType: 'USER', actorMemberId: member.memberId, data: { memberId: member.memberId } }),
    ])
    // The event names the member: never the LINE user id, the code or the token (NFR-SEC-09)
    expect(JSON.stringify(linked[0]!.data)).not.toContain(lineUserId)

    expect(menuOf(lineUserId)).toBe(org.linkedMenu)
    const welcome = pushesTo(lineUserId)
    expect(welcome).toHaveLength(1)
    expect(welcome[0]).toMatchObject({ retryKey: identity!.id })
    expect(JSON.stringify(welcome[0]!.messages)).toContain('ผูกบัญชี BCS กับ LINE นี้แล้ว')
    // The LIFF sign-in of S5-03 now finds the member
    expect(await findLiffLinkedUser(lineUserId, ENV.liffChannelId)).toEqual({ ok: true, userId: member.userId })
    expect(ok(await getMyLineLink(member.ctx()))).toMatchObject({ available: true, linked: true, linkedAt: identity!.linkedAt.toISOString(), reachable: true })
  })

  it('works once: the same request again answers the same and links once; the code with another LINE account is TOKEN_USED', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const code = await codeOf(member)
    const lineUserId = newLineUserId()
    const request = { code: code.code, idToken: idTokenFor(lineUserId) }
    expect(await postLink(request)).toEqual({ status: 200, body: { ok: true } })
    // A double tap: the same answer, no second link, event or welcome (LINE takes the retry key once)
    expect(await postLink(request)).toEqual({ status: 200, body: { ok: true } })
    expect(await liveLinks(org.orgId)).toHaveLength(1)
    expect(await eventsOf(org.orgId, 'line.linked')).toHaveLength(1)
    expect(pushesTo(lineUserId)).toHaveLength(1)
    const other = newLineUserId()
    expect(await postLink({ code: code.code, idToken: idTokenFor(other) })).toEqual({ status: 409, body: { ok: false, code: 'TOKEN_USED' } })
    expect(await liveLinks(org.orgId)).toEqual([expect.objectContaining({ externalUserId: lineUserId })])
  })

  it('lives 10 minutes on the security clock: refused at 10 minutes (TOKEN_EXPIRED) without asking LINE, and so is a code from ahead of the clock', async () => {
    const org = await lineOrg()
    const [early, late, ahead] = [await person(org.orgId), await person(org.orgId), await person(org.orgId)]
    const t0 = new Date()
    const code = await codeOf(early, t0)
    const calls = verifyCalls
    expect(await linkLineAccount({ code: code.code, idToken: idTokenFor(newLineUserId()) }, { now: new Date(t0.getTime() + LINE_LINK_CODE_TTL_MS) })).toMatchObject({
      ok: false,
      error: { code: 'TOKEN_EXPIRED' },
    })
    expect(verifyCalls).toBe(calls)
    // One millisecond before, it links
    expect(await linkLineAccount({ code: code.code, idToken: idTokenFor(newLineUserId()) }, { now: new Date(t0.getTime() + LINE_LINK_CODE_TTL_MS - 1) })).toMatchObject({ ok: true })

    const stale = await codeOf(late, new Date(Date.now() - LINE_LINK_CODE_TTL_MS - MS_PER_SECOND))
    expect(await postLink({ code: stale.code, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 410, body: { ok: false, code: 'TOKEN_EXPIRED' } })
    const future = await codeOf(ahead, new Date(Date.now() + MS_PER_MINUTE))
    expect(await postLink({ code: future.code, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 410, body: { ok: false, code: 'TOKEN_EXPIRED' } })
    expect((await liveLinks(org.orgId)).map((l) => l.memberId)).toEqual([early.memberId])
  })

  it('refuses a code this server did not make or that was changed (TOKEN_INVALID), before LINE is asked', async () => {
    const org = await lineOrg()
    const [member, other] = [await person(org.orgId), await person(org.orgId)]
    const { code } = await codeOf(member)
    const [, orgPart, , at, nonce] = partsOf(code)
    const foreignMac = createHmac('sha256', 'another-server-secret-0000000000000000').update(['bcs/line-link-code/v1', orgPart, uuidPart(other.memberId), at, nonce].join('|')).digest('base64url')
    const forged = [
      // another member's id under this code's signature
      withPart(code, 2, uuidPart(other.memberId)),
      // signed with another server's secret
      withPart(withPart(code, 2, uuidPart(other.memberId)), 5, foreignMac),
      // the same signature spelled another way (would hash differently and slip past "once")
      withPart(code, 5, respelled(partsOf(code)[5]!)),
      withPart(code, 4, respelled(nonce!)),
      // the time with a leading zero
      withPart(code, 3, `0${at}`),
      withPart(code, 3, String(Number(at) + 1)),
      code.replace(/^l1\./, 'l2.'),
      code.slice(0, -1),
      'not-a-code',
    ]
    const calls = verifyCalls
    for (const candidate of forged) {
      expect(await postLink({ code: candidate, idToken: idTokenFor(newLineUserId()) }), candidate).toEqual({ status: 400, body: { ok: false, code: 'TOKEN_INVALID' } })
    }
    expect(verifyCalls).toBe(calls)
    // Longer than any code: refused as a body, unread
    expect(await postLink({ code: `${code}${'x'.repeat(200)}`, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 400, body: { ok: false, code: 'VALIDATION_FAILED', field: 'code' } })
    expect(await liveLinks(org.orgId)).toEqual([])
    expect(await prisma.channelLinkCode.count({ where: { organizationId: org.orgId } })).toBe(0)
  })

  it('takes the LINE user only from an ID token LINE verified for this LIFF app (BR-LINE-01, BR-LINE-02): a foreign, wrong-audience or expired token is 401, LINE down is 502, and the code stays usable', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { code } = await codeOf(member)
    const lineUserId = newLineUserId()
    const refused = { status: 401, body: { ok: false, code: 'UNAUTHENTICATED', reason: 'ID_TOKEN_INVALID' } }
    expect(await postLink({ code, idToken: elsewhere.issueIdToken({ sub: lineUserId, aud: ENV.liffChannelId }) })).toEqual(refused)
    expect(await postLink({ code, idToken: idTokenFor(lineUserId, { aud: '1650000099' }) })).toEqual(refused)
    expect(await postLink({ code, idToken: idTokenFor(lineUserId, { expiresInSeconds: -10 }) })).toEqual(refused)
    expect(await postLink({ code, idToken: 'not.a.token' })).toEqual(refused)
    // A LINE user id or a profile from the browser is never read: the body is { code, idToken } and nothing else
    expect(await postLink({ code, idToken: idTokenFor(lineUserId), lineUserId: newLineUserId() })).toEqual({ status: 400, body: { ok: false, code: 'VALIDATION_FAILED', field: '(body)' } })
    lineDown = true
    try {
      expect(await postLink({ code, idToken: idTokenFor(lineUserId) })).toEqual({ status: 502, body: { ok: false, code: 'EXTERNAL_SERVICE_ERROR' } })
    } finally {
      lineDown = false
    }
    expect(await liveLinks(org.orgId)).toEqual([])
    // Nothing above spent the code
    expect(await postLink({ code, idToken: idTokenFor(lineUserId) })).toEqual({ status: 200, body: { ok: true } })
    expect(await liveLinks(org.orgId)).toEqual([expect.objectContaining({ externalUserId: lineUserId })])
  })

  it('answers pages of this site only, and a body of { code, idToken } only (403, 400, 413)', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { code } = await codeOf(member)
    const request = { code, idToken: idTokenFor(newLineUserId()) }
    expect(await postLink(request, { origin: 'https://evil.example' })).toEqual({ status: 403, body: { ok: false, code: 'FORBIDDEN', reason: 'CROSS_SITE' } })
    expect(await postLink(request, { headers: { 'sec-fetch-site': 'cross-site' } })).toEqual({ status: 403, body: { ok: false, code: 'FORBIDDEN', reason: 'CROSS_SITE' } })
    expect(await postLink('{not json')).toEqual({ status: 400, body: { ok: false, code: 'VALIDATION_FAILED', field: '(body)' } })
    expect(await postLink({ code })).toEqual({ status: 400, body: { ok: false, code: 'VALIDATION_FAILED', field: 'idToken' } })
    expect(await postLink({ code, idToken: 'x'.repeat(20_000) })).toEqual({ status: 413, body: { ok: false, code: 'VALIDATION_FAILED', field: '(body)', reason: 'TOO_LARGE' } })
    expect(await liveLinks(org.orgId)).toEqual([])
  })
})

describe('[FR-LINE-001/AC1] the code is for an active member of an organization that uses LINE (refusals)', () => {
  it('gives no code to an actor that is not the member, to a member who is not active, or where LINE is off, not set up or another LIFF app', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const notLinked = (r: Result<unknown>) => expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'LINE_NOT_ENABLED' } } })
    expect(await issueLineLinkCode(systemCtx(org.orgId, new Date()))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await issueLineLinkCode(makeCtx({ organizationId: org.orgId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: new Date() }))).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(await getMyLineLink(systemCtx(org.orgId, new Date()))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await prisma.member.update({ where: { id: member.memberId }, data: { status: 'DEACTIVATED' } })
    expect(await issueLineLinkCode(member.ctx())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getMyLineLink(member.ctx())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    const noChannel = await createOrg()
    notLinked(await issueLineLinkCode((await person(noChannel.id)).ctx()))
    const off = await lineOrg({ active: false, menus: false })
    notLinked(await issueLineLinkCode((await person(off.orgId)).ctx()))
    const otherApp = await lineOrg({ liffChannelId: '1650000077', menus: false })
    notLinked(await issueLineLinkCode((await person(otherApp.orgId)).ctx()))
    expect(ok(await getMyLineLink((await person(otherApp.orgId)).ctx()))).toEqual({ available: false, linked: false, linkedAt: null, reachable: true })
  })

  it('refuses the link once the member was deactivated, the LIFF app changed or LINE was switched off after the code was given, and leaves the code unspent', async () => {
    const org = await lineOrg()
    const [gone, moved, stays] = [await person(org.orgId), await person(org.orgId), await person(org.orgId)]
    const goneCode = await codeOf(gone)
    const movedCode = await codeOf(moved)
    const staysCode = await codeOf(stays)
    await prisma.member.update({ where: { id: gone.memberId }, data: { status: 'DEACTIVATED' } })
    expect(await postLink({ code: goneCode.code, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 403, body: { ok: false, code: 'FORBIDDEN' } })

    const notEnabled = { status: 409, body: { ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'LINE_NOT_ENABLED' } }
    const versionOf = async () => (await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: org.orgId } })).version
    // Another LIFF app than this environment's: its ID tokens are not the ones LINE verified here (ADR-024)
    ok(await saveLineChannelSettings(org.adminCtx, { ...CHANNEL, channelSecret: '', channelAccessToken: '', liffId: '1650000077-OtHeRaPp', liffChannelId: '1650000077', active: true, expectedVersion: await versionOf() }, key()))
    expect(await postLink({ code: movedCode.code, idToken: idTokenFor(newLineUserId()) })).toEqual(notEnabled)
    ok(await saveLineChannelSettings(org.adminCtx, { ...CHANNEL, channelSecret: '', channelAccessToken: '', active: false, expectedVersion: await versionOf() }, key()))
    expect(await postLink({ code: staysCode.code, idToken: idTokenFor(newLineUserId()) })).toEqual(notEnabled)
    expect(await liveLinks(org.orgId)).toEqual([])
    expect(await prisma.channelLinkCode.count({ where: { organizationId: org.orgId } })).toBe(0)
  })
})

describe('[FR-LINE-001/AC1] before the tap, the LIFF page shows whose account a code links: read only, LINE not asked', () => {
  it('gives the organization and the member’s name, and nothing else about them; nothing is written and the code still links', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    await prisma.member.update({ where: { id: member.memberId }, data: { displayNameTh: 'สมชาย ใจดี', displayNameEn: 'Somchai Jaidee' } })
    const code = await codeOf(member)
    const calls = verifyCalls
    const preview = ok(await previewLineLinkCode({ code: code.code }))
    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: org.orgId } })
    expect(preview).toEqual({ organizationName: organization.displayName ?? organization.legalNameTh, memberNameTh: 'สมชาย ใจดี', memberNameEn: 'Somchai Jaidee', expiresAt: code.expiresAt })
    expect(JSON.stringify(preview)).not.toContain(member.email)
    expect(verifyCalls).toBe(calls)
    expect(await prisma.channelLinkCode.count({ where: { organizationId: org.orgId } })).toBe(0)
    // Shown twice (a reload), it still links once confirmed
    expect(ok(await previewLineLinkCode({ code: code.code }))).toEqual(preview)
    expect(await postLink({ code: code.code, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 200, body: { ok: true } })
  })

  it('refuses as the link would: a changed, foreign or expired code, a used one, an inactive member, LINE switched off, and a body other than { code }', async () => {
    const org = await lineOrg({ menus: false })
    const [member, gone, late] = [await person(org.orgId), await person(org.orgId), await person(org.orgId)]
    const { code } = await codeOf(member)
    const goneCode = await codeOf(gone)
    const lateCode = await codeOf(late)
    const refused = (code: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, ...(details ? { details } : {}) } })
    expect(await previewLineLinkCode({ code: code.slice(0, -1) })).toMatchObject(refused('TOKEN_INVALID'))
    expect(await previewLineLinkCode({ code: withPart(code, 2, uuidPart(gone.memberId)) })).toMatchObject(refused('TOKEN_INVALID'))
    expect(await previewLineLinkCode({ code: 'not-a-code' })).toMatchObject(refused('TOKEN_INVALID'))
    expect(await previewLineLinkCode({ code: (await codeOf(member, new Date(Date.now() - LINE_LINK_CODE_TTL_MS - MS_PER_SECOND))).code })).toMatchObject(refused('TOKEN_EXPIRED'))
    expect(await previewLineLinkCode({ code, idToken: idTokenFor(newLineUserId()) })).toMatchObject(refused('VALIDATION_FAILED', { field: '(body)' }))
    expect(await previewLineLinkCode(null)).toMatchObject(refused('VALIDATION_FAILED'))
    await prisma.member.update({ where: { id: gone.memberId }, data: { status: 'DEACTIVATED' } })
    expect(await previewLineLinkCode({ code: goneCode.code })).toMatchObject(refused('FORBIDDEN'))
    expect(await postLink({ code, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 200, body: { ok: true } })
    expect(await previewLineLinkCode({ code })).toMatchObject(refused('TOKEN_USED'))
    const { version } = await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: org.orgId } })
    ok(await saveLineChannelSettings(org.adminCtx, { ...CHANNEL, channelSecret: '', channelAccessToken: '', active: false, expectedVersion: version }, key()))
    expect(await previewLineLinkCode({ code: lateCode.code })).toMatchObject(refused('INVALID_STATE_TRANSITION', { reason: 'LINE_NOT_ENABLED' }))
  })
})

describe('[FR-LINE-001/AC1] a code cannot outlive the link it made room for, nor be tried without end', () => {
  it('is ended by an unlink: a code shown before the member’s last unlink is refused (TOKEN_EXPIRED, UNLINKED_SINCE) and stays unspent; a new code links', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    // A QR shown (or photographed by someone else) before the member linked and unlinked
    const earlier = await codeOf(member)
    const { lineUserId } = await linkVia(member)
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    const calls = verifyCalls
    expect(await postLink({ code: earlier.code, idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 410, body: { ok: false, code: 'TOKEN_EXPIRED', reason: 'UNLINKED_SINCE' } })
    expect(verifyCalls).toBe(calls + 1)
    expect(await previewLineLinkCode({ code: earlier.code })).toMatchObject({ ok: false, error: { code: 'TOKEN_EXPIRED', details: { reason: 'UNLINKED_SINCE' } } })
    expect(await liveLinks(org.orgId)).toEqual([])
    expect(await prisma.channelLinkCode.count({ where: { organizationId: org.orgId, codeHash: lineLinkCodeHash(earlier.code) } })).toBe(0)
    const fresh = await codeOf(member)
    expect(await postLink({ code: fresh.code, idToken: idTokenFor(lineUserId) })).toEqual({ status: 200, body: { ok: true } })
  })

  it(`asks LINE at most ${LINE_LINK_ATTEMPTS_MAX} times for one member’s codes within a code’s lifetime (NFR-SEC-05): then 429 without asking LINE, for any code of that member; others link as usual`, async () => {
    const org = await lineOrg({ menus: false })
    const [member, other] = [await person(org.orgId), await person(org.orgId)]
    const { code } = await codeOf(member)
    const calls = verifyCalls
    for (let i = 0; i < LINE_LINK_ATTEMPTS_MAX; i++) {
      expect(await postLink({ code, idToken: 'not.a.token' })).toEqual({ status: 401, body: { ok: false, code: 'UNAUTHENTICATED', reason: 'ID_TOKEN_INVALID' } })
    }
    expect(verifyCalls).toBe(calls + LINE_LINK_ATTEMPTS_MAX)
    // A new code of the same member starts no new count, and a good ID token does not get through either
    const again = await codeOf(member)
    const limited = await postLink({ code: again.code, idToken: idTokenFor(newLineUserId()) })
    expect(limited).toEqual({ status: 429, body: { ok: false, code: 'RATE_LIMITED', reason: 'LINK_ATTEMPTS', time: expect.any(String) } })
    expect(verifyCalls).toBe(calls + LINE_LINK_ATTEMPTS_MAX)
    const until = new Date(String(limited.body!.time))
    expect(until.getTime()).toBeGreaterThan(Date.now())
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + LINE_LINK_CODE_TTL_MS)
    // A forged code is refused before it is counted or LINE is asked
    expect(await postLink({ code: code.slice(0, -1), idToken: idTokenFor(newLineUserId()) })).toEqual({ status: 400, body: { ok: false, code: 'TOKEN_INVALID' } })
    expect(await liveLinks(org.orgId)).toEqual([])
    await linkVia(other)
    // Once that window is over the member's codes are taken again
    const next = await codeOf(member, until)
    expect(await linkLineAccount({ code: next.code, idToken: idTokenFor(newLineUserId()) }, { now: until })).toMatchObject({ ok: true })
  })

  it('answers 200 once the link committed, even when the menu switch and the welcome both fail after the commit; the menu follows in job line-rich-menu', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const code = await codeOf(member)
    const lineUserId = newLineUserId()
    const sentBefore = toInngest.length
    // Every use of the LINE channel throws once the link is in: opening the channel included
    setLineClient({
      channel: () => {
        throw new Error('the LINE client broke after the commit')
      },
    })
    let answer: Awaited<ReturnType<typeof postLink>>
    try {
      answer = await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })
    } finally {
      setLineClient(line.client)
    }
    expect(answer).toEqual({ status: 200, body: { ok: true } })
    const [identity] = await liveLinks(org.orgId)
    expect(identity).toMatchObject({ memberId: member.memberId, externalUserId: lineUserId })
    expect(await eventsOf(org.orgId, 'line.linked')).toHaveLength(1)
    expect(menuOf(lineUserId)).toBeNull()
    expect(pushesTo(lineUserId)).toEqual([])
    const handed = toInngest.slice(sentBefore).find((m) => m.name === 'bcs/line.linked' && (m.data as { aggregateId?: string }).aggregateId === identity!.id)
    expect(await lineRichMenuRun({ data: handed!.data }, jobStep)).toEqual({ status: 'APPLIED', menu: 'LINKED' })
    expect(menuOf(lineUserId)).toBe(org.linkedMenu)
  })
})

/** The password step through Better Auth's HTTP handler, as the LIFF page's sign-in form sends it */
async function signIn(email: string) {
  const env = getEnv()
  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  )
  const body = response.ok ? ((await response.json()) as { twoFactorRedirect?: boolean }) : null
  return { status: response.status, cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), twoFactor: Boolean(body?.twoFactorRedirect) }
}

/** The authenticator step */
async function verifyTotp(cookie: string, code: string) {
  const env = getEnv()
  const response = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/two-factor/verify-totp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, cookie, 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ code }),
    }),
  )
  return { status: response.status, cookie: response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }
}

describe('[FR-LINE-001/AC2] starting from LINE: the LIFF page signs in with e-mail, password and 2FA, then links the same way', () => {
  it('a member who signed in with the password and the authenticator code in the LINE browser gets a code there and links', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId, { roles: ['FINANCE'], totpSecret: TOTP_SECRET })
    const first = await signIn(member.email)
    expect(first).toMatchObject({ status: 200, twoFactor: true })
    // The password alone opens no session the link could use
    expect(ctxFromSession(await resolveSession(new Headers({ cookie: first.cookie }), { channel: 'LIFF' }), 'LIFF', new Date())).toBeNull()
    const second = await verifyTotp(first.cookie, totp(TOTP_SECRET))
    expect(second.status).toBe(200)
    const state = await resolveSession(new Headers({ cookie: second.cookie }), { channel: 'LIFF' })
    expect(state.kind).toBe('member')
    const ctx = ctxFromSession(state, 'LIFF', new Date())!
    expect(ctx).toMatchObject({ organizationId: org.orgId, actor: { type: 'USER', memberId: member.memberId }, channel: 'LIFF' })
    const code = ok(await issueLineLinkCode(ctx))
    const lineUserId = newLineUserId()
    expect(await postLink({ code: code.code, idToken: idTokenFor(lineUserId) })).toEqual({ status: 200, body: { ok: true } })
    expect(await liveLinks(org.orgId)).toEqual([expect.objectContaining({ memberId: member.memberId, externalUserId: lineUserId })])
    expect(await eventsOf(org.orgId, 'line.linked')).toEqual([expect.objectContaining({ channel: 'LIFF', actorMemberId: member.memberId })])
    expect(menuOf(lineUserId)).toBe(org.linkedMenu)
  })

  it('a member who still has to set up the authenticator gets no code (FR-AUTH-002 AC1)', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId, { roles: ['FINANCE'] })
    const signedIn = await signIn(member.email)
    expect(signedIn).toMatchObject({ status: 200, twoFactor: false })
    const state = await resolveSession(new Headers({ cookie: signedIn.cookie }), { channel: 'LIFF' })
    expect(state.kind).toBe('needs-2fa-setup')
    expect(ctxFromSession(state, 'LIFF', new Date())).toBeNull()
  })
})

describe('[FR-LINE-001/AC3] one member per LINE account in an organization and one LINE account per member; unlinking from either side', () => {
  it('refuses a LINE account linked to another member and a member linked to another account, with the reason, and leaves the code unspent', async () => {
    const org = await lineOrg()
    const [a, b] = [await person(org.orgId), await person(org.orgId)]
    const spare = await codeOf(a)
    const again = await codeOf(a)
    const { lineUserId } = await linkVia(a)

    const bCode = await codeOf(b)
    expect(await postLink({ code: bCode.code, idToken: idTokenFor(lineUserId) })).toEqual({
      status: 409,
      body: { ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER' },
    })
    expect(await postLink({ code: spare.code, idToken: idTokenFor(newLineUserId()) })).toEqual({
      status: 409,
      body: { ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'MEMBER_LINKED_TO_ANOTHER_ACCOUNT' },
    })
    expect(await postLink({ code: again.code, idToken: idTokenFor(lineUserId) })).toEqual({ status: 409, body: { ok: false, code: 'INVALID_STATE_TRANSITION', reason: 'ALREADY_LINKED' } })
    // While linked, no new code: unlink first
    expect(await issueLineLinkCode(a.ctx())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'ALREADY_LINKED' } } })
    // B's code was not spent by the refusal: B links another LINE account with it
    const bLine = newLineUserId()
    expect(await postLink({ code: bCode.code, idToken: idTokenFor(bLine) })).toEqual({ status: 200, body: { ok: true } })
    expect((await liveLinks(org.orgId)).map((l) => [l.memberId, l.externalUserId])).toEqual([
      [a.memberId, lineUserId],
      [b.memberId, bLine],
    ])
  })

  it('counts per organization: the same LINE account links to a member of another organization', async () => {
    const first = await lineOrg({ menus: false })
    const second = await lineOrg({ menus: false })
    const { lineUserId } = await linkVia(await person(first.orgId))
    const other = await person(second.orgId)
    await linkVia(other, lineUserId)
    expect(await liveLinks(second.orgId)).toEqual([expect.objectContaining({ memberId: other.memberId, externalUserId: lineUserId })])
  })

  it('unlinks from the workspace: line.unlinked, the UNLINKED menu at once, the LIFF session no longer stands, and a new link later', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId, identityId } = await linkVia(member)
    expect(menuOf(lineUserId)).toBe(org.linkedMenu)
    expect(await liffSessionMemberIds(member.userId)).toEqual(new Set([member.memberId]))

    expect(await unlinkMyLine(member.ctx('WEB'), {}, key())).toEqual({ ok: true, data: { identityId, lineActionTokensRevoked: 0 } })
    const ended = await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })
    expect(ended.unlinkedAt).toBeInstanceOf(Date)
    expect(await eventsOf(org.orgId, 'line.unlinked')).toEqual([
      expect.objectContaining({ aggregateType: 'ChannelIdentity', aggregateId: identityId, channel: 'WEB', actorMemberId: member.memberId, data: { memberId: member.memberId, reason: 'SELF' } }),
    ])
    // The account's default (UNLINKED) shows again
    expect(menuOf(lineUserId)).toBeNull()
    expect(line.fake.defaultRichMenu()).toBe(org.unlinkedMenu)
    // A LIFF session of the member ends at its next request (S5-03 checks the link every time)
    expect(await liffSessionMemberIds(member.userId)).toEqual(new Set())
    expect(ok(await getMyLineLink(member.ctx()))).toMatchObject({ linked: false, linkedAt: null })
    expect(await unlinkMyLine(member.ctx('WEB'), {}, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_LINKED' } } })

    // Linking again makes a new row; the ended one stays as history
    const relinked = await linkVia(member)
    expect(relinked.identityId).not.toBe(identityId)
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).toEqual(ended.unlinkedAt)
  })

  it('unlinks from the LIFF app: a LIFF session (a LINE sign-in) ends its own link, and with it the session', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId, identityId } = await linkVia(member)
    const env = getEnv()
    const signedIn = await liffSessionRoute(
      new Request(`${env.APP_URL.replace(/\/+$/, '')}/api/liff/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: new URL(env.APP_URL).origin, 'x-forwarded-for': '198.51.100.77' },
        body: JSON.stringify({ idToken: idTokenFor(lineUserId) }),
      }),
    )
    expect(signedIn.status).toBe(200)
    const headers = new Headers({ cookie: signedIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') })
    const ctx = ctxFromSession(await resolveSession(headers, { channel: 'LIFF' }), 'LIFF', new Date())
    expect(ctx).toMatchObject({ actor: { type: 'USER', memberId: member.memberId }, channel: 'LIFF' })
    expect(await unlinkMyLine(ctx!, {}, key())).toMatchObject({ ok: true, data: { identityId } })
    expect(await eventsOf(org.orgId, 'line.unlinked')).toEqual([expect.objectContaining({ aggregateId: identityId, channel: 'LIFF', data: { memberId: member.memberId, reason: 'SELF' } })])
    expect(menuOf(lineUserId)).toBeNull()
    // The LINE sign-in stood on that link: it is over at the next request
    expect((await resolveSession(headers, { channel: 'LIFF' })).kind).toBe('anonymous')
  })

  it('unlinks only the member’s own link: other actors are refused and another member’s link id is not found', async () => {
    const org = await lineOrg({ menus: false })
    const [a, b] = [await person(org.orgId), await person(org.orgId)]
    const aLink = await linkVia(a)
    await linkVia(b)
    expect(await unlinkMyLine(systemCtx(org.orgId, new Date()), {}, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await unlinkMyLine(makeCtx({ organizationId: org.orgId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: randomUUID() }, channel: 'WEB', now: new Date() }), {}, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
    expect(await unlinkMyLine(b.ctx(), { identityId: aLink.identityId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'NOT_LINKED' } } })
    expect(await unlinkMyLine(b.ctx(), { memberId: a.memberId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    await prisma.member.update({ where: { id: b.memberId }, data: { status: 'DEACTIVATED' } })
    expect(await unlinkMyLine(b.ctx(), {}, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect((await liveLinks(org.orgId)).map((l) => l.memberId).sort()).toEqual([a.memberId, b.memberId].sort())
  })

  it('has no unlink in the chat: a postback v=1&a=unlink carries no action token (BR-TOK-02), so it is skipped and the link stays', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    const tap = lineEvents.postback({ userId: lineUserId, data: 'v=1&a=unlink' })
    expect(await deliver(org.channelKey, [tap])).toBe(200)
    const row = await eventually(
      () => prisma.lineWebhookEvent.findFirstOrThrow({ where: { organizationId: org.orgId, webhookEventId: tap.webhookEventId } }),
      (r) => r.status !== 'RECEIVED',
    )
    expect(row).toMatchObject({ status: 'SKIPPED', error: 'POSTBACK_UNKNOWN_ACTION' })
    expect(repliesTo(tap)).toEqual([])
    expect(await liveLinks(org.orgId)).toEqual([expect.objectContaining({ memberId: member.memberId, externalUserId: lineUserId })])
    expect(await eventsOf(org.orgId, 'line.unlinked')).toEqual([])
  })

  it('does not unlink when the user blocks the account (unfollow): the member stays linked and unreachable until they follow again', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    const { lineUserId } = await linkVia(member)
    expect(await deliver(org.channelKey, [lineEvents.unfollow({ userId: lineUserId })])).toBe(200)
    await eventually(
      async () => (await prisma.member.findUniqueOrThrow({ where: { id: member.memberId } })).lineReachable,
      (reachable) => !reachable,
    )
    expect(await liveLinks(org.orgId)).toHaveLength(1)
    expect(ok(await getMyLineLink(member.ctx()))).toMatchObject({ linked: true, reachable: false })
    expect(await deliver(org.channelKey, [lineEvents.follow({ userId: lineUserId, unblocked: true })])).toBe(200)
    expect(await eventually(async () => ok(await getMyLineLink(member.ctx())), (link) => link.reachable)).toMatchObject({ linked: true, reachable: true })
  })

  it('takes lineReachable of a new link from what LINE said about that LINE account, not from an earlier link (BR-LINE-08)', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    // The member's earlier LINE account blocked the account
    const first = await linkVia(member)
    expect(await deliver(org.channelKey, [lineEvents.unfollow({ userId: first.lineUserId })])).toBe(200)
    await eventually(
      async () => (await prisma.member.findUniqueOrThrow({ where: { id: member.memberId } })).lineReachable,
      (reachable) => !reachable,
    )
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    // A new account LINE said nothing about: reachable
    await linkVia(member)
    expect((await prisma.member.findUniqueOrThrow({ where: { id: member.memberId } })).lineReachable).toBe(true)
    ok(await unlinkMyLine(member.ctx(), {}, key()))
    // An account that blocked the OA before it was linked (that unfollow was recorded, though nobody was marked then)
    const blocked = newLineUserId()
    const history = [lineEvents.follow({ userId: blocked, timestamp: Date.now() - 2 * MS_PER_SECOND }), lineEvents.unfollow({ userId: blocked, timestamp: Date.now() - MS_PER_SECOND })]
    expect(await deliver(org.channelKey, history)).toBe(200)
    expect(
      await eventually(
        () => prisma.lineWebhookEvent.findMany({ where: { organizationId: org.orgId, webhookEventId: { in: history.map((e) => e.webhookEventId) } }, select: { status: true } }),
        (rows) => rows.length === 2 && rows.every((r) => r.status !== 'RECEIVED'),
      ),
    ).toHaveLength(2)
    await linkVia(member, blocked)
    expect((await prisma.member.findUniqueOrThrow({ where: { id: member.memberId } })).lineReachable).toBe(false)
  })
})

describe('[FR-AUTH-003/AC2] deactivating a member ends their LINE link in the deactivation’s transaction', () => {
  it('ends the link with line.unlinked beside member.deactivated; job line-rich-menu puts the UNLINKED menu back; a LIFF sign-in is refused', async () => {
    const org = await lineOrg()
    const member = await person(org.orgId)
    const { lineUserId, identityId } = await linkVia(member)
    const result = ok(await deactivateMember(org.adminCtx, { memberId: member.memberId, reason: 'ลาออก' }, { idempotencyKey: randomUUID() }))
    expect(result.revoked).toMatchObject({ lineLink: 1 })
    const [deactivated] = await eventsOf(org.orgId, 'member.deactivated')
    const unlinked = await eventsOf(org.orgId, 'line.unlinked')
    expect(unlinked).toEqual([
      expect.objectContaining({
        aggregateId: identityId,
        requestId: deactivated!.requestId,
        correlationId: deactivated!.correlationId,
        occurredAt: deactivated!.occurredAt,
        actorMemberId: org.admin.memberId,
        data: { memberId: member.memberId, reason: 'MEMBER_DEACTIVATED' },
      }),
    ])
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).toEqual(deactivated!.occurredAt)
    // Nothing called LINE inside the transaction: the menu changes in the job the event starts
    expect(menuOf(lineUserId)).toBe(org.linkedMenu)
    const message = toInngest.find((m) => m.name === 'bcs/line.unlinked' && (m.data as { aggregateId?: string }).aggregateId === identityId)
    expect(message).toBeDefined()
    expect(await lineRichMenuRun({ data: message!.data }, jobStep)).toEqual({ status: 'APPLIED', menu: 'UNLINKED' })
    expect(menuOf(lineUserId)).toBeNull()
    expect(await findLiffLinkedUser(lineUserId, ENV.liffChannelId)).toEqual({ ok: false, reason: 'LINK_REQUIRED' })
  })

  it('keeps the link when the deactivation fails after the revokers ran (one transaction)', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    const { identityId } = await linkVia(member)
    // A revoker after the LINE one breaks: the whole deactivation is rolled back
    registerDeactivationRevoker('test-breaks-after-line', async () => {
      throw new Error('a later revoker failed')
    })
    try {
      expect(await deactivateMember(org.adminCtx, { memberId: member.memberId, reason: 'ลาออก' }, key())).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    } finally {
      registerDeactivationRevoker('test-breaks-after-line', async () => ({ count: 0 }))
    }
    expect((await prisma.channelIdentity.findUniqueOrThrow({ where: { id: identityId } })).unlinkedAt).toBeNull()
    expect(await eventsOf(org.orgId, 'line.unlinked')).toEqual([])
    expect((await prisma.member.findUniqueOrThrow({ where: { id: member.memberId } })).status).toBe('ACTIVE')
  })
})

describe('[FR-LINE-001/AC3] the LINE action tokens of a member end with their link (BR-TOK-01)', () => {
  it('revokes the member’s unused LINE tokens on unlink and leaves the e-mail ones', async () => {
    const org = await lineOrg({ menus: false })
    const member = await person(org.orgId)
    await linkVia(member)
    // An approval task of the member with both buttons (S5-05 issues the LINE one on assignment; written here)
    const task = await approvalTaskOf(org.orgId, member.memberId)
    const expiresAt = new Date(Date.now() + 72 * MS_PER_HOUR)
    const [lineToken, emailToken] = await Promise.all(
      (['LINE', 'EMAIL'] as const).map((channel) =>
        prisma.actionToken.create({
          data: { organizationId: org.orgId, memberId: member.memberId, taskId: task, allowedActions: ['APPROVE'], channel, expiresAt, ...(channel === 'EMAIL' ? { secretHash: 'a'.repeat(64) } : {}) },
        }),
      ),
    )
    expect(await unlinkMyLine(member.ctx(), {}, key())).toMatchObject({ ok: true, data: { lineActionTokensRevoked: 1 } })
    expect((await prisma.actionToken.findUniqueOrThrow({ where: { id: lineToken!.id } })).revokedAt).toBeInstanceOf(Date)
    expect((await prisma.actionToken.findUniqueOrThrow({ where: { id: emailToken!.id } })).revokedAt).toBeNull()
  })
})

/** An open approval task of the member on a route of a draft DOA version (only the token rows matter here) */
async function approvalTaskOf(organizationId: string, memberId: string): Promise<string> {
  const doa = await prisma.doaVersion.create({
    data: { organizationId, code: 'DOA-TEST', versionNo: 1, effectiveFrom: new Date('2026-01-01T00:00:00Z'), amountBasis: 'NET', selfApprovalPolicy: 'ESCALATE_NEXT_BAND', sodPolicy: {} },
  })
  const route = await prisma.approvalRoute.create({
    data: { organizationId, subjectType: 'REQUEST', subjectId: randomUUID(), routeNo: 1, doaVersionId: doa.id, ruleCode: 'PR-01', amountBasis: 'NET', explanationTh: 'ทดสอบ' },
  })
  const step = await prisma.approvalStep.create({ data: { organizationId, routeId: route.id, stepNo: 1, slaBusinessMinutes: 480, status: 'ACTIVE' } })
  const task = await prisma.approvalTask.create({ data: { organizationId, stepId: step.id, assigneeMemberId: memberId, resolvedFrom: 'TEST', assignedAt: new Date() } })
  return task.id
}
