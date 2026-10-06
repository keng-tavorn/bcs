import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider, type EmailMessage } from '@/integrations/email-provider'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { fromBase32, totp } from '@/lib/totp'
import { auth } from '@/server/auth/auth'
import { upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { resetRefusal, retryAfterSeconds, setupCodeRefusal, setupPasswordRefusal, signInRefusal } from '@/ui/auth/answers'

// §9.9 rule 7 · FR-AUTH-001 AC2 AC3 · FR-AUTH-002 AC1 · FR-LINE-001 AC2: what Better Auth really answers the calls whose
// answers the forms word (src/ui/auth/answers.ts, tests/unit/auth-answers.test.ts), through its HTTP handler as a browser
// reaches it — its limit on requests included, which counts per address (x-forwarded-for) in the database. These are the
// answers that were worded for the wrong cause: an e-mail that is not one ("check your connection", the sign-in inside
// LIFF), a new password longer than the rule ("the link has expired", /reset-password) and too many tries of the
// authenticator setup ("wrong password", the workspace's setup screen).

const PASSWORD = 'correct-horse-battery-9'
const outbox: EmailMessage[] = []

beforeAll(() => {
  setEmailProvider({
    async send(message) {
      outbox.push(message)
      return { messageId: randomUUID() }
    },
  })
})
afterAll(() => setEmailProvider(null))

/** An address of this test alone (100.64.0.0/10), so no limit or lock counted for another test applies to it */
function newAddress(): string {
  const [a, b] = randomBytes(2)
  return `100.${64 + (a! % 64)}.${b!}.${1 + (randomBytes(1)[0]! % 254)}`
}

/** A POST to Better Auth's HTTP handler (the path a browser uses) from an address, with a session cookie or none */
function post(path: string, body: unknown, from: { readonly ip: string; readonly cookie?: string }): Promise<Response> {
  const env = getEnv()
  return auth.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.APP_URL, 'x-forwarded-for': from.ip, ...(from.cookie ? { cookie: from.cookie } : {}) },
      body: JSON.stringify(body),
    }),
  )
}

/** A refused answer as the forms read it: its status and Better Auth's code */
async function failureOf(response: Response): Promise<{ status: number; code?: string }> {
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null
  return { status: response.status, ...(typeof body?.code === 'string' ? { code: body.code } : {}) }
}

const cookieOf = (response: Response) => response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

async function signedIn(): Promise<{ readonly email: string; readonly userId: string; readonly cookie: string }> {
  const email = `${randomUUID()}@test.bcs.local`
  const userId = await upsertUserWithPassword({ email, name: 'ผู้ใช้ทดสอบ', password: PASSWORD })
  const response = await post('/sign-in/email', { email, password: PASSWORD }, { ip: newAddress() })
  expect(response.status).toBe(200)
  return { email, userId, cookie: cookieOf(response) }
}

describe('[FR-AUTH-001/AC3] [FR-LINE-001/AC2] an address that is not an e-mail is refused as such, never as a connection that failed', () => {
  it.each(['', 'auditor@demo', 'not an e-mail'])('sign-in with %j: 400 INVALID_EMAIL, worded on the e-mail field', async (email) => {
    const response = await post('/sign-in/email', { email, password: 'not-the-password-123' }, { ip: newAddress() })
    const failure = await failureOf(response)
    expect(failure).toEqual({ status: 400, code: 'INVALID_EMAIL' })
    expect(signInRefusal(failure)).toBe('emailInvalid')
  })
})

describe('[FR-AUTH-001/AC2] a new password outside the rule is refused before the e-mailed link is used: the link still works', () => {
  it('too long, then too short: each said on the password field; then the password is saved, and only then is the link used', async () => {
    const email = `${randomUUID()}@test.bcs.local`
    await upsertUserWithPassword({ email, name: 'ผู้ใช้ทดสอบ', password: PASSWORD })
    await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' }, headers: new Headers() })
    const link = /https?:\/\/\S+/.exec([...outbox].reverse().find((m) => m.to === email)?.text ?? '')?.[0] ?? ''
    const token = new URL(link).pathname.split('/').pop()!
    const ip = newAddress()

    const tooLong = await failureOf(await post('/reset-password', { newPassword: 'x'.repeat(PASSWORD_MAX_LENGTH + 1), token }, { ip }))
    expect(tooLong).toEqual({ status: 400, code: 'PASSWORD_TOO_LONG' })
    expect(resetRefusal(tooLong)).toBe('tooLong')
    const tooShort = await failureOf(await post('/reset-password', { newPassword: 'x'.repeat(PASSWORD_MIN_LENGTH - 1), token }, { ip }))
    expect(tooShort).toEqual({ status: 400, code: 'PASSWORD_TOO_SHORT' })
    expect(resetRefusal(tooShort)).toBe('tooShort')

    // The longest password the rule takes is saved with the same link: neither refusal used it
    expect((await post('/reset-password', { newPassword: 'y'.repeat(PASSWORD_MAX_LENGTH), token }, { ip })).status).toBe(200)
    // Used now: only this is the link's own refusal
    const used = await failureOf(await post('/reset-password', { newPassword: 'another-long-pass-42', token }, { ip }))
    expect(used).toEqual({ status: 400, code: 'INVALID_TOKEN' })
    expect(resetRefusal(used)).toBe('linkInvalid')
  })
})

describe('[FR-AUTH-002/AC1] the authenticator setup: too many tries from one address are refused before the password is checked', () => {
  it('3 in 10 seconds; the 4th, even with the right password, is 429 with the seconds to wait — not a wrong password — and sets nothing up', async () => {
    const member = await signedIn()
    const ip = newAddress()
    for (let i = 0; i < 3; i++) {
      const wrong = await failureOf(await post('/two-factor/enable', { password: 'not-the-password-123' }, { ip, cookie: member.cookie }))
      expect(wrong).toEqual({ status: 400, code: 'INVALID_PASSWORD' })
      expect(setupPasswordRefusal(wrong)).toBe('wrongPassword')
    }
    const limited = await post('/two-factor/enable', { password: PASSWORD }, { ip, cookie: member.cookie })
    const wait = retryAfterSeconds(limited.headers)
    const failure = await failureOf(limited)
    expect(failure).toEqual({ status: 429 })
    expect(setupPasswordRefusal(failure)).toBe('busy')
    expect(wait).toBeGreaterThanOrEqual(1)
    expect(wait).toBeLessThanOrEqual(10)
    expect(await prisma.twoFactor.count({ where: { userId: member.userId } })).toBe(0)

    // The limit is the address's: from another one the right password starts the setup
    const started = await post('/two-factor/enable', { password: PASSWORD }, { ip: newAddress(), cookie: member.cookie })
    expect(started.status).toBe(200)
    expect(((await started.json()) as { totpURI?: string }).totpURI).toMatch(/^otpauth:\/\//)
  })

  it('a session that ended and a setup already done are said for what they are; a wrong code is the only wrong code', async () => {
    const member = await signedIn()
    // No session: the password step, and the code step (Better Auth then looks for a sign-in waiting for its code)
    const noSession = await failureOf(await post('/two-factor/enable', { password: PASSWORD }, { ip: newAddress() }))
    expect(noSession).toEqual({ status: 401, code: 'UNAUTHORIZED' })
    expect(setupPasswordRefusal(noSession)).toBe('signedOut')
    const noSessionCode = await failureOf(await post('/two-factor/verify-totp', { code: '123456' }, { ip: newAddress() }))
    expect(noSessionCode).toEqual({ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' })
    expect(setupCodeRefusal(noSessionCode)).toBe('signedOut')

    const started = await post('/two-factor/enable', { password: PASSWORD }, { ip: newAddress(), cookie: member.cookie })
    const { totpURI } = (await started.json()) as { totpURI: string }
    const secret = fromBase32(new URL(totpURI).searchParams.get('secret')!).toString('utf8')
    const right = totp(secret)
    const wrongCode = `${(Number(right[0]) + 5) % 10}${right.slice(1)}`
    const wrong =await failureOf(await post('/two-factor/verify-totp', { code: wrongCode }, { ip: newAddress(), cookie: member.cookie }))
    expect(wrong).toEqual({ status: 401, code: 'INVALID_CODE' })
    expect(setupCodeRefusal(wrong)).toBe('invalidCode')
    const confirmed = await post('/two-factor/verify-totp', { code: totp(secret) }, { ip: newAddress(), cookie: member.cookie })
    expect(confirmed.status).toBe(200)

    // Set up (in another tab, say): starting again is refused as done, not as a wrong password
    const again = await failureOf(await post('/two-factor/enable', { password: PASSWORD }, { ip: newAddress(), cookie: cookieOf(confirmed) }))
    expect(again).toEqual({ status: 400, code: 'TOTP_ALREADY_ENABLED' })
    expect(setupPasswordRefusal(again)).toBe('alreadyOn')
  })
})
