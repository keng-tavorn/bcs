import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/liff/session/route'
import { MS_PER_HOUR } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { resolveSession } from '@/server/auth/session'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { newLineUserId } from '../../scripts/line-simulate'
import { createMember, createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET, withFakeLine } from '../support/fake-line'

// S5-03 · a LINE sign-in in a browser that holds a live session of another sign-in identity (FR-AUTH-003 AC1, §9.4): POST
// /api/liff/session refuses it (403 SIGNED_IN_AS_ANOTHER_USER), the other session stays with its cookie, and the refusal
// is recorded like a failed web sign-in: auth.login_failed of the LINE account's member, step liff, channel LIFF, with
// its reason — never the ID token, the LINE user id or the other session's token (src/server/auth/liff.ts). The LIFF
// page's answer to it (the gate, signing out) is tests/e2e/liff-another-user.spec.ts.

const LIFF_CHANNEL = '1650000063'
const PROVIDER = '1650000061'
const CHANNEL = {
  providerId: PROVIDER,
  messagingChannelId: '1650000062',
  channelSecret: TEST_CHANNEL_SECRET,
  channelAccessToken: TEST_ACCESS_TOKEN,
  liffId: `${LIFF_CHANNEL}-AnOtHeRu`,
  liffChannelId: LIFF_CHANNEL,
}

const line = withFakeLine()

beforeAll(() => {
  // LINE's verify endpoint as the fake LINE server of this file answers it
  setLiffVerification({ channelId: LIFF_CHANNEL, fetch: (input, init) => fetch(String(input).replace(getEnv().LINE_API_BASE_URL, line.fake.url), init) })
})
afterAll(() => setLiffVerification(null))

/** An organization whose ORG_ADMIN saved its LINE channel, switched on */
async function lineOrg(): Promise<string> {
  const org = await createOrg()
  const admin = await createMember(org.id, 'ผู้ดูแล')
  await prisma.roleAssignment.create({ data: { organizationId: org.id, memberId: admin.id, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const ctx = makeCtx({ organizationId: org.id, actor: { type: 'USER', memberId: admin.id }, channel: 'WEB', now: new Date() })
  const saved = await saveLineChannelSettings(ctx, { ...CHANNEL, active: true }, { idempotencyKey: randomUUID(), sender: null })
  if (!saved.ok) throw new Error(saved.error.code)
  return org.id
}

/** A member with a sign-in identity (a password) whose LINE account is linked under the channel's provider */
async function linkedUser(orgId: string) {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ LIFF', password: 'liff-another-user-1' })
  const member = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้ LIFF', status: 'ACTIVE', userId } })
  const lineUserId = newLineUserId()
  await prisma.channelIdentity.create({ data: { organizationId: orgId, memberId: member.id, channel: 'LINE', providerKey: PROVIDER, externalUserId: lineUserId, linkedAt: new Date() } })
  return { userId, memberId: member.id, lineUserId }
}

/** The cookie Better Auth signs for a session token (better-call: HMAC-SHA256 with the auth secret, URI-encoded) */
async function signedCookieFor(token: string): Promise<string> {
  const context = await auth.$context
  const signature = createHmac('sha256', context.secret).update(token).digest('base64')
  return `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`
}

const sessionCookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => c.includes('session_token=') && !c.endsWith('='))
    .join('; ')

/** POST /api/liff/session as the LIFF page sends it (same origin), with the browser's cookie */
async function liffSignIn(idToken: string, cookie?: string) {
  const env = getEnv()
  const response = await POST(
    new Request(`${env.APP_URL.replace(/\/+$/, '')}/api/liff/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: new URL(env.APP_URL).origin,
        'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ idToken }),
    }),
  )
  return { status: response.status, cookie: sessionCookieOf(response), body: (await response.json().catch(() => null)) as Record<string, unknown> | null }
}

const tokenFor = (lineUserId: string) => line.fake.issueIdToken({ sub: lineUserId, aud: LIFF_CHANNEL })

describe('[FR-AUTH-003/AC1] a LINE sign-in refused for someone else’s live sign-in is recorded with its reason', () => {
  it('a password session, then a LINE session of another identity: both refusals are auth.login_failed SIGNED_IN_AS_ANOTHER_USER of the LINE account’s member', async () => {
    const orgId = await lineOrg()
    const a = await linkedUser(orgId)
    const b = await linkedUser(orgId)
    const since = new Date()
    // a signed in with a password in b's LINE browser
    const now = new Date()
    const aWeb = await prisma.session.create({ data: { id: randomUUID(), token: randomBytes(24).toString('hex'), userId: a.userId, expiresAt: new Date(now.getTime() + 12 * MS_PER_HOUR), createdAt: now, updatedAt: now } })
    const aWebCookie = await signedCookieFor(aWeb.token)
    const idToken = tokenFor(b.lineUserId)
    expect(await liffSignIn(idToken, aWebCookie)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN', reason: 'SIGNED_IN_AS_ANOTHER_USER' }, cookie: '' })
    expect(await resolveSession(new Headers({ cookie: aWebCookie }))).toMatchObject({ kind: 'member', userId: a.userId })
    // a signed in through LINE in that browser
    const aLiff = await liffSignIn(tokenFor(a.lineUserId))
    expect(aLiff.status).toBe(200)
    expect(await liffSignIn(tokenFor(b.lineUserId), aLiff.cookie)).toMatchObject({ status: 403, body: { reason: 'SIGNED_IN_AS_ANOTHER_USER' }, cookie: '' })
    expect(await resolveSession(new Headers({ cookie: aLiff.cookie }), { channel: 'LIFF' })).toMatchObject({ kind: 'member', userId: a.userId })

    const failed = await prisma.event.findMany({ where: { type: 'auth.login_failed', aggregateId: b.memberId, occurredAt: { gte: since } }, orderBy: { seq: 'asc' } })
    expect(failed.map((e) => ({ channel: e.channel, organizationId: e.organizationId, actorMemberId: e.actorMemberId }))).toEqual([
      { channel: 'LIFF', organizationId: orgId, actorMemberId: b.memberId },
      { channel: 'LIFF', organizationId: orgId, actorMemberId: b.memberId },
    ])
    for (const event of failed) expect(event.data).toMatchObject({ step: 'liff', reason: 'SIGNED_IN_AS_ANOTHER_USER', memberKnown: true })
    const recorded = JSON.stringify(failed.map((e) => e.data))
    for (const secret of [idToken, b.lineUserId, aWeb.token, aLiff.cookie]) expect(recorded).not.toContain(secret)
  })
})
