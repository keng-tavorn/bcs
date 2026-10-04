import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The browser of /settings/line is what these tests choose: Next.js's request objects (next/headers) hold the cookies a
// test puts in `browser.jar`. Everything else — the session lookup, the services, the database — is the real path.
const browser = vi.hoisted(() => ({ jar: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    getAll: () => [...browser.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void browser.jar.set(name, value),
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next-intl/server', () => ({ getLocale: async () => 'th' }))
// This environment's LIFF app (ADR-024) and LIFF_MOCK (local only), set before anything reads the environment
const ENV = vi.hoisted(() => {
  const before = { NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID, LINE_LIFF_CHANNEL_ID: process.env.LINE_LIFF_CHANNEL_ID, LIFF_MOCK: process.env.LIFF_MOCK }
  const values = { liffId: '1650000033-SeTtInGs', liffChannelId: '1650000033' }
  process.env.NEXT_PUBLIC_LIFF_ID = values.liffId
  process.env.LINE_LIFF_CHANNEL_ID = values.liffChannelId
  process.env.LIFF_MOCK = '1'
  return { ...values, before }
})

import { issueLineLinkCodeAction, lineLinkStatusAction } from '@/app/(workspace)/settings/line/actions'
import { MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { auth } from '@/server/auth/auth'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { saveLineChannelSettings } from '@/server/services/line-channel'
import { createOrg } from '../support/factory'
import { TEST_ACCESS_TOKEN, TEST_CHANNEL_SECRET } from '../support/fake-line'

// /settings/line (FR-LINE-001 AC1, FR-AUTH-003 AC1). While the page shows a link code it asks every few seconds whether
// the code was used in LINE: that question is the page's own, not the member's, so it is no activity of the session —
// it never keeps an idle session alive, and a session past its limits is still refused and ended. With LIFF_MOCK (local
// only) the link under the QR code is the LIFF page of this machine, said to be local.

afterAll(() => {
  for (const [name, value] of Object.entries(ENV.before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

let orgId: string
beforeAll(async () => {
  const org = await createOrg()
  orgId = org.id
  const admin = await member()
  await prisma.roleAssignment.create({ data: { organizationId: orgId, memberId: admin.memberId, role: 'ORG_ADMIN', grantedAt: new Date() } })
  const ctx = makeCtx({ organizationId: orgId, actor: { type: 'USER', memberId: admin.memberId }, channel: 'WEB', now: new Date() })
  const saved = await saveLineChannelSettings(
    ctx,
    { providerId: '1650000031', messagingChannelId: '1650000032', channelSecret: TEST_CHANNEL_SECRET, channelAccessToken: TEST_ACCESS_TOKEN, liffId: ENV.liffId, liffChannelId: ENV.liffChannelId, active: true },
    { idempotencyKey: randomUUID(), sender: null },
  )
  if (!saved.ok) throw new Error(`channel not saved: ${saved.error.code}`)
})

/** A member of the organization with a sign-in identity (a plain member: no role, no TOTP needed) */
async function member() {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้เว็บ', password: 'settings-line-password-1' })
  const row = await prisma.member.create({ data: { organizationId: orgId, email, displayNameTh: 'ผู้ใช้เว็บ', status: 'ACTIVE', userId } })
  return { memberId: row.id, userId }
}

/** The browser holds a password session of the user that started `startedAgoMinutes` ago and was last active then */
async function signedInBrowser(userId: string, startedAgoMinutes: number) {
  const createdAt = new Date(Date.now() - startedAgoMinutes * MS_PER_MINUTE)
  const token = randomBytes(24).toString('hex')
  const session = await prisma.session.create({ data: { id: randomUUID(), token, userId, createdAt, updatedAt: createdAt, expiresAt: new Date(createdAt.getTime() + 12 * MS_PER_HOUR) } })
  const context = await auth.$context
  const signature = createHmac('sha256', context.secret).update(token).digest('base64')
  browser.jar.clear()
  browser.jar.set(context.authCookies.sessionToken.name, `${token}.${signature}`)
  return session
}

const lastActiveOf = async (sessionId: string) => (await prisma.session.findUnique({ where: { id: sessionId }, select: { lastActiveAt: true } }))?.lastActiveAt

describe('[FR-AUTH-003/AC1] the link-status poll of /settings/line is no activity of the session', () => {
  it('answers while the session lives without moving its idle clock; a request of the member does move it', async () => {
    const { userId } = await member()
    const session = await signedInBrowser(userId, 5)
    for (let i = 0; i < 3; i++) expect(await lineLinkStatusAction()).toEqual({ ok: true, linked: false })
    expect(await lastActiveOf(session.id)).toBeNull()
    // Asking for a code is the member's own doing: activity, recorded as before
    expect(await issueLineLinkCodeAction()).toMatchObject({ ok: true })
    expect((await lastActiveOf(session.id))?.getTime()).toBeGreaterThan(session.createdAt.getTime())
  })

  it('refuses and ends a session past the idle limit, however often the page polled it', async () => {
    const { userId } = await member()
    const session = await signedInBrowser(userId, 31)
    expect(await lineLinkStatusAction()).toEqual({ ok: false, code: 'UNAUTHENTICATED' })
    expect(await prisma.session.count({ where: { id: session.id } })).toBe(0)
  })
})

describe('[FR-LINE-001/AC1] with LIFF_MOCK the code’s link and QR open the LIFF page of this machine', () => {
  it('gives the local /liff/link?code=…, marked local, never LINE’s address', async () => {
    const { userId } = await member()
    await signedInBrowser(userId, 1)
    const issued = await issueLineLinkCodeAction()
    if (!issued.ok) throw new Error(`no code: ${issued.code}`)
    expect(issued.local).toBe(true)
    expect(issued.url).toMatch(new RegExp(`^${getEnv().APP_URL.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/liff/link\\?code=l1\\.`))
    expect(issued.url).not.toContain('liff.line.me')
    expect(issued.qr.path.length).toBeGreaterThan(0)
  })
})
