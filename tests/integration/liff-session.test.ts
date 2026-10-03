import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { prisma } from '@/server/db/client'
import { auth } from '@/server/auth/auth'
import { setLiffUserResolver, setLiffVerification } from '@/server/auth/liff'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { resolveSession } from '@/server/auth/session'
import { createOrg } from '../support/factory'

// BR-LINE-01/02 spike for S1-07 (the LIFF app itself is S5): a session is created only from an ID token that
// LINE's verify endpoint accepts for our channel, with our own aud/exp/iss checks on top.
const CHANNEL_ID = '2000000001'
const LINE_USER = `U${randomUUID().replace(/-/g, '')}`
const calls: Array<{ url: string; body: URLSearchParams }> = []

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / MS_PER_SECOND)
  return { iss: 'https://access.line.me', sub: LINE_USER, aud: CHANNEL_ID, exp: now + 600, iat: now, ...overrides }
}

const fakeLine: typeof fetch = async (input, init) => {
  const body = new URLSearchParams(String(init?.body ?? ''))
  calls.push({ url: String(input), body })
  const answers: Record<string, () => Response> = {
    good: () => Response.json(claims()),
    'wrong-aud': () => Response.json(claims({ aud: '1999999999' })),
    expired: () => Response.json(claims({ exp: Math.floor(Date.now() / MS_PER_SECOND) - 10 })),
    'wrong-iss': () => Response.json(claims({ iss: 'https://example.com' })),
    'no-sub': () => Response.json(claims({ sub: '' })),
    'line-down': () => new Response('upstream error', { status: 503 }),
  }
  return (answers[body.get('id_token') ?? ''] ?? (() => Response.json({ error: 'invalid_request', error_description: 'Invalid IdToken.' }, { status: 400 })))()
}

async function liffSignIn(idToken: string) {
  const env = getEnv()
  const res = await auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/liff/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL },
      body: JSON.stringify({ idToken }),
    }),
  )
  return { status: res.status, cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }
}

let userId: string
beforeAll(async () => {
  const org = await createOrg()
  const email = `${randomUUID()}@test.bcs.local`
  userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ LIFF', password: 'liff-user-password-1' })
  await prisma.member.create({ data: { organizationId: org.id, email, displayNameTh: 'ผู้ใช้ LIFF', status: 'ACTIVE', userId } })
  setLiffVerification({ channelId: CHANNEL_ID, fetch: fakeLine })
  setLiffUserResolver(async (lineUserId) => (lineUserId === LINE_USER ? userId : null))
})
afterAll(() => {
  setLiffVerification(null)
  setLiffUserResolver(null)
})

describe('[BR-LINE-02] LIFF ID token sign-in', () => {
  it('a token LINE accepts for our channel creates a session for the linked member', async () => {
    const r = await liffSignIn('good')
    expect(r.status).toBe(200)
    expect(calls.at(-1)!.url).toBe(`${getEnv().LINE_API_BASE_URL}/oauth2/v2.1/verify`)
    expect(calls.at(-1)!.body.get('client_id')).toBe(CHANNEL_ID)
    const state = await resolveSession(new Headers({ cookie: r.cookie }), { channel: 'LIFF' })
    expect(state).toMatchObject({ kind: 'member', userId })
  })

  it.each(['forged', 'wrong-aud', 'expired', 'wrong-iss', 'no-sub'])('%s token is refused and creates no session', async (token) => {
    const before = await prisma.session.count({ where: { userId } })
    const r = await liffSignIn(token)
    expect(r.status).toBe(401)
    expect(r.cookie).not.toContain('session_token')
    expect(await prisma.session.count({ where: { userId } })).toBe(before)
  })

  it('a LINE account that is not linked to a member is refused', async () => {
    setLiffUserResolver(async () => null)
    try {
      expect((await liffSignIn('good')).status).toBe(403)
    } finally {
      setLiffUserResolver(async (lineUserId) => (lineUserId === LINE_USER ? userId : null))
    }
  })

  it('LINE being unavailable is reported as such, not as a bad token', async () => {
    expect((await liffSignIn('line-down')).status).toBe(503)
  })
})
