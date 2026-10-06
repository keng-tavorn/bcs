import { describe, expect, it } from 'vitest'
import { CLIENT_MESSAGES, pickMessages } from '@/i18n/client-messages'
import { errorStatus, failedToAnswer, settled } from '@/ui/auth/client'
import { signInRefusal, type SignInRefusal } from '@/ui/auth/login-form'
import th from '../../messages/th.json'

// FR-AUTH-001 · FR-AUTH-002 · §9.9 rule 7 ("ข้อความ error บอกว่าเกิดอะไรและแก้อย่างไร"): what the sign-in, the second step,
// the forgot and reset pages and the authenticator setup say when their call of Better Auth does not go through. A request
// that gets no answer makes fetch throw, and Better Auth's browser client lets it through: settled turns it into an error
// of status 0, so no form stays busy for good and silent; failedToAnswer tells such an error, or a server failure, from
// a refusal, so a form never calls a password, a code or a link wrong when the server never checked it. The forms
// themselves in a browser — the empty fields, the refused e-mail and the dropped connection — are tests/e2e/auth.spec.ts.

describe('[FR-AUTH-001/AC3] a call of the auth client always settles, and no answer is not taken for a refusal', () => {
  it('a request that throws (no connection) comes back as an error of status 0', async () => {
    const answer = await settled(Promise.reject(new TypeError('Failed to fetch')))
    expect(answer).toEqual({ data: null, error: { status: 0, statusText: '' } })
    expect(errorStatus(answer.error)).toBe(0)
    expect(failedToAnswer(answer.error!)).toBe(true)
  })

  it('an answer, refused or not, comes back as it was', async () => {
    const refused = { data: null, error: { status: 401, statusText: 'Unauthorized', code: 'INVALID_EMAIL_OR_PASSWORD' } }
    expect(await settled(Promise.resolve(refused))).toBe(refused)
    const signedIn = { data: { twoFactorRedirect: true }, error: null }
    expect(await settled(Promise.resolve(signedIn))).toBe(signedIn)
  })

  it.each([
    [0, true],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
    [429, false],
  ])('status %i: no answer or a server failure is %s', (status, failed) => {
    expect(failedToAnswer({ status })).toBe(failed)
  })
})

describe('[FR-AUTH-001/AC3] the web sign-in words each answer of its first step for what happened', () => {
  it.each<[{ status?: number; code?: string }, SignInRefusal]>([
    // No answer or a server failure: check the connection and send again
    [{ status: 0 }, 'failed'],
    [{}, 'failed'],
    [{ status: 500 }, 'failed'],
    [{ status: 504 }, 'failed'],
    // Locked: the lock's own words (which lock, and when it lifts)
    [{ status: 429, code: 'LOGIN_LOCKED' }, 'locked'],
    [{ status: 429 }, 'locked'],
    // Not an e-mail (Better Auth's z.email(), an empty one included): on the e-mail field
    [{ status: 400, code: 'INVALID_EMAIL' }, 'emailInvalid'],
    // Refused, without saying which part was wrong
    [{ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' }, 'invalid'],
    [{ status: 400, code: 'PASSWORD_TOO_LONG' }, 'invalid'],
    [{ status: 400, code: 'VALIDATION_ERROR' }, 'invalid'],
  ])('%o is %s', (failure, refusal) => {
    expect(signInRefusal(failure)).toBe(refusal)
  })

  it('only the failed answer speaks of the connection; the field checks say what to fill in', () => {
    const login = th.auth.login
    expect(login.failed).toContain('ตรวจการเชื่อมต่อ')
    for (const words of [login.invalid, login.emailRequired, login.passwordRequired, login.emailInvalid]) expect(words).not.toContain('การเชื่อมต่อ')
    expect(login.emailRequired).toContain(login.email)
    expect(login.passwordRequired).toContain(login.password)
  })
})

describe('[FR-LINE-001/AC2] the LIFF sign-in carries the web sign-in’s words it reads, not the web form’s own checks (ADR-052)', () => {
  it('/liff/link holds the words of auth.login that the LIFF sign-in shows, and nothing else of it', () => {
    const picked = pickMessages(th, CLIENT_MESSAGES.liffLink)
    expect(Object.keys(picked.auth?.login ?? {}).sort()).toEqual(['email', 'failed', 'forgot', 'invalid', 'password', 'submit', 'submitting'])
    expect(picked.auth?.lock).toEqual(th.auth.lock)
    expect(picked.auth?.twoFactor).toEqual(th.auth.twoFactor)
  })
})
