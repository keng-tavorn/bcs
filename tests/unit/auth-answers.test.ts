import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createTranslator } from 'next-intl'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_MESSAGES, pickMessages } from '@/i18n/client-messages'
import { MS_PER_MINUTE, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, TWO_FACTOR_LOCK_LIMIT, TWO_FACTOR_LOCK_MS } from '@/lib/constants'
import {
  lockWords,
  resetRefusal,
  retryAfterSeconds,
  secondStepRefusal,
  serverFailed,
  setupCodeRefusal,
  setupPasswordRefusal,
  signInRefusal,
  type AuthFailure,
  type LockWords,
  type ResetRefusal,
  type SecondStepRefusal,
  type SetupRefusal,
  type SignInRefusal,
} from '@/ui/auth/answers'
import { errorStatus, failedToAnswer, settled, settledWithWait } from '@/ui/auth/client'
import enMessages from '../../messages/en.json'
import th from '../../messages/th.json'

// FR-AUTH-001 · FR-AUTH-002 · FR-LINE-001 AC2 · §9.9 rule 7 ("ข้อความ error บอกว่าเกิดอะไรและแก้อย่างไร"): what the sign-in
// (on the web and inside LIFF), the second step, the forgot and reset pages and the authenticator setup say when their
// call of Better Auth does not go through (src/ui/auth/answers.ts). A request that gets no answer makes fetch throw, and
// Better Auth's browser client lets it through: settled turns it into an error of status 0, so no form stays busy for
// good and silent; failedToAnswer tells such an error, or a server failure, from a refusal, so a form never calls a
// password, a code or a link wrong when the server never checked it. Neither is a limit on requests a wrong password,
// nor a password too long an expired link. That Better Auth answers these statuses and codes is
// tests/integration/auth-answers.test.ts; the forms themselves in a browser — the empty fields, the refused e-mail and the
// dropped connection — are tests/e2e/auth.spec.ts and tests/e2e/liff-link.spec.ts.

const en = enMessages as unknown as typeof th
const ROOT = path.resolve(import.meta.dirname, '../..')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

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

describe('[FR-AUTH-001/AC3] [FR-LINE-001/AC2] the web sign-in and the sign-in inside LIFF word each answer of the first step for what happened', () => {
  it.each<[AuthFailure, SignInRefusal]>([
    // No answer: check the connection and send again
    [{ status: 0 }, 'failed'],
    [{}, 'failed'],
    // A server failure: the request reached BCS, which failed before checking anything — wait and send again, never
    // "check your connection", which worked (D-05 round 4)
    [{ status: 500 }, 'serverFailed'],
    [{ status: 502 }, 'serverFailed'],
    [{ status: 504 }, 'serverFailed'],
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
    for (const words of [login.invalid, login.emailRequired, login.passwordRequired, login.emailInvalid, login.serverFailed]) expect(words).not.toContain('การเชื่อมต่อ')
    expect(login.emailRequired).toContain(login.email)
    expect(login.passwordRequired).toContain(login.password)
  })

  it('a server failure says the e-mail and password were not checked, and to press the button again after a moment, in Thai and in English', () => {
    expect(th.auth.login.serverFailed).toBe('ระบบขัดข้อง จึงยังไม่ได้ตรวจอีเมลและรหัสผ่าน รอสักครู่แล้วกด เข้าสู่ระบบ อีกครั้ง')
    expect(th.auth.login.serverFailed).toContain(th.auth.login.submit)
    expect(en.auth.login.serverFailed).toBe('BCS had a fault, so your e-mail and password were not checked. Wait a moment, then press Sign in again.')
    expect(en.auth.login.serverFailed).toContain(en.auth.login.submit)
    expect(en.auth.login.serverFailed.toLowerCase()).not.toContain('connection')
  })
})

describe('[FR-AUTH-001/AC3] [FR-AUTH-002/AC1] a refused sign-in step names the lock that refused it (§9.9 rule 7)', () => {
  it.each<[{ code?: string; reason?: unknown; retryAt?: unknown }, LockWords]>([
    // Ours: this account or this network address, with when it lifts
    [{ code: 'LOGIN_LOCKED', reason: 'ACCOUNT', retryAt: '2026-10-06T03:15:00.000Z' }, 'account'],
    [{ code: 'LOGIN_LOCKED', reason: 'IP', retryAt: '2026-10-06T03:15:00.000Z' }, 'address'],
    // Better Auth's lock of the second step: its own words, never "too many requests"
    [{ code: 'ACCOUNT_TEMPORARILY_LOCKED' }, 'secondStep'],
    // A plain limit on requests (no code), or ours without a time it lifts
    [{}, 'busy'],
    [{ code: 'LOGIN_LOCKED' }, 'busy'],
    [{ code: 'LOGIN_LOCKED', retryAt: 'not a time' }, 'busy'],
  ])('%o is %s', (failure, words) => {
    expect(lockWords(failure)).toBe(words)
  })

  it('the second step’s lock says how many wrong codes paused it, that backup codes wait too, and how long, in Thai and in English', () => {
    const values = { limit: TWO_FACTOR_LOCK_LIMIT, minutes: TWO_FACTOR_LOCK_MS / MS_PER_MINUTE }
    expect(createTranslator({ locale: 'th', messages: th, namespace: 'auth.lock' })('secondStep', values)).toBe(
      'ใส่รหัสยืนยันตัวตนผิดติดกัน 10 ครั้ง ระบบจึงพักการยืนยันตัวตนขั้นที่สองของบัญชีนี้ไว้ 15 นาที (รหัสสำรองก็ใช้ไม่ได้ระหว่างนี้) รอ 15 นาทีแล้วลองใหม่',
    )
    expect(createTranslator({ locale: 'en', messages: en, namespace: 'auth.lock' })('secondStep', values)).toBe(
      'The verification code was wrong 10 times in a row, so the second sign-in step of this account is paused for 15 minutes (backup codes too). Wait 15 minutes, then try again.',
    )
    expect(th.auth.lock.secondStep).not.toContain('ถี่เกินไป')
  })
})

describe('[FR-LINE-001/AC2] [FR-AUTH-002/AC1] the second sign-in step words each answer for what happened', () => {
  it.each<[AuthFailure, SecondStepRefusal]>([
    // The step waited too long: Better Auth no longer knows the sign-in, which starts again with the password
    [{ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' }, 'expired'],
    // No answer or a server failure: the code was not checked, so it is not called wrong
    [{ status: 0 }, 'failed'],
    [{}, 'failed'],
    [{ status: 502 }, 'failed'],
    // Locked: the lock's own words
    [{ status: 429, code: 'LOGIN_LOCKED' }, 'locked'],
    [{ status: 429 }, 'locked'],
    // A code that is wrong, expired or used
    [{ status: 401, code: 'INVALID_CODE' }, 'invalid'],
    [{ status: 401, code: 'INVALID_BACKUP_CODE' }, 'invalid'],
  ])('%o is %s', (failure, refusal) => {
    expect(secondStepRefusal(failure)).toBe(refusal)
  })

  it.each([
    [0, false],
    [500, true],
    [502, true],
    [503, true],
    [400, false],
    [401, false],
    [429, false],
  ])('status %i: a server failure (the request reached BCS, which failed) is %s — no answer is not one', (status, failed) => {
    expect(serverFailed({ status })).toBe(failed)
  })

  it('a code the server failed to check is said so on the web, never as a dropped connection nor as a wrong code, in Thai and in English', () => {
    expect(th.auth.twoFactor.serverFailed).toBe('ระบบขัดข้อง จึงยังไม่ได้ตรวจรหัส รอสักครู่แล้วกด ยืนยันและเข้าสู่ระบบ อีกครั้ง')
    expect(th.auth.twoFactor.serverFailed).toContain(th.auth.twoFactor.submit)
    expect(th.auth.twoFactor.serverFailed).not.toContain('การเชื่อมต่อ')
    expect(th.auth.twoFactor.serverFailed).not.toContain('ไม่ถูกต้อง')
    expect(en.auth.twoFactor.serverFailed).toBe('BCS had a fault, so your code was not checked. Wait a moment, then press Verify and sign in again.')
    expect(en.auth.twoFactor.serverFailed).toContain(en.auth.twoFactor.submit)
    expect(en.auth.twoFactor.serverFailed.toLowerCase()).not.toMatch(/connection|wrong/)
  })

  it('with a backup code, the words above the field ask for one, and say what to do without any left — not to open the app', () => {
    expect(th.auth.twoFactor.backupIntro).toBe('ใส่รหัสสำรองหนึ่งรหัสจากชุดที่เก็บไว้ตอนตั้งค่าการยืนยันตัวตนสองชั้น ถ้าไม่มีรหัสสำรองเหลือแล้ว ให้ผู้ดูแลระบบขององค์กรรีเซ็ตให้')
    expect(en.auth.twoFactor.backupIntro).toBe(
      'Enter one of the backup codes you kept when you set up two-step verification. If you have none left, ask your organization admin to reset it.',
    )
    expect(th.auth.twoFactor.intro).toContain('เปิดแอป')
    expect(th.auth.twoFactor.backupIntro).not.toContain('แอป')
    expect(en.auth.twoFactor.backupIntro).not.toMatch(/\bapp\b/i)
  })
})

describe('[FR-LINE-001/AC2] the sign-in inside LIFF reads the answers as the web sign-in does, and carries the words it shows (ADR-052)', () => {
  it('/liff/link holds the words of auth.login that the LIFF sign-in shows — its fields’ checks included — and nothing else of it', () => {
    const picked = pickMessages(th, CLIENT_MESSAGES.liffLink)
    expect(Object.keys(picked.auth?.login ?? {}).sort()).toEqual(['email', 'emailInvalid', 'emailRequired', 'failed', 'forgot', 'invalid', 'password', 'passwordRequired', 'serverFailed', 'submit', 'submitting'])
    expect(picked.auth?.lock).toEqual(th.auth.lock)
    expect(picked.auth?.twoFactor).toEqual(th.auth.twoFactor)
  })

  it('it words the answers with the web sign-in’s mapping, which has no import at all: Better Auth’s browser client stays out of LIFF', () => {
    const liff = readFileSync(path.join(ROOT, 'src/ui/liff/liff-sign-in.tsx'), 'utf8')
    expect(liff).toMatch(/import \{ lockWords, secondStepRefusal, serverFailed, signInRefusal \} from '\.\.\/auth\/answers'/)
    expect(liff).not.toMatch(/from '(?:\.\.\/auth\/client|@\/ui\/auth\/client|better-auth[^']*)'/)
    const answers = readFileSync(path.join(ROOT, 'src/ui/auth/answers.ts'), 'utf8')
    expect(answers).not.toMatch(/^import /m)
    expect(readFileSync(path.join(ROOT, 'src/ui/auth/login-form.tsx'), 'utf8')).toMatch(/import \{ signInRefusal \} from '\.\/answers'/)
  })
})

describe('[FR-AUTH-001/AC2] a new password from the e-mailed link that was not saved: only a link Better Auth does not take is called expired', () => {
  it.each<[AuthFailure, ResetRefusal]>([
    // No answer or a server failure: the link was not used, send again
    [{ status: 0 }, 'failed'],
    [{}, 'failed'],
    [{ status: 500 }, 'failed'],
    [{ status: 503 }, 'failed'],
    // Better Auth's limit on requests, before anything is read: wait, the link still works
    [{ status: 429 }, 'busy'],
    // The password rule, checked before the link: on the password field
    [{ status: 400, code: 'PASSWORD_TOO_SHORT' }, 'tooShort'],
    [{ status: 400, code: 'PASSWORD_TOO_LONG' }, 'tooLong'],
    // A link Better Auth does not take: expired, used, never issued, or its account gone
    [{ status: 400, code: 'INVALID_TOKEN' }, 'linkInvalid'],
    [{ status: 400, code: 'USER_NOT_FOUND' }, 'linkInvalid'],
  ])('%o is %s', (failure, refusal) => {
    expect(resetRefusal(failure)).toBe(refusal)
  })

  it('a password too long says the rule on its field, and nothing but the link’s own words speaks of an expired link', () => {
    const thReset = createTranslator({ locale: 'th', messages: th, namespace: 'auth.reset' })
    const enReset = createTranslator({ locale: 'en', messages: en, namespace: 'auth.reset' })
    expect(thReset('tooLong', { max: PASSWORD_MAX_LENGTH })).toBe('รหัสผ่านยาวเกินไป ใช้ไม่เกิน 128 ตัวอักษร')
    expect(enReset('tooLong', { max: PASSWORD_MAX_LENGTH })).toBe('The password is too long. Use at most 128 characters.')
    expect(th.auth.reset.invalidLink).toContain('หมดอายุ')
    const thTooShort = createTranslator({ locale: 'th', messages: th, namespace: 'auth.invite' })('tooShort', { min: PASSWORD_MIN_LENGTH })
    for (const words of [thReset('tooLong', { max: PASSWORD_MAX_LENGTH }), thReset('busy', { seconds: 7 }), th.auth.reset.failed, thTooShort]) {
      expect(words).not.toContain('หมดอายุ')
      expect(words).not.toContain('ใช้ไปแล้ว')
    }
    for (const words of [enReset('tooLong', { max: PASSWORD_MAX_LENGTH }), enReset('busy', { seconds: 7 }), en.auth.reset.failed]) expect(words).not.toContain('expired')
  })

  it('too many requests: the password was not saved, the link still works, and how long to wait — the seconds the server sent, or a moment', () => {
    const thReset = createTranslator({ locale: 'th', messages: th, namespace: 'auth.reset' })
    const enReset = createTranslator({ locale: 'en', messages: en, namespace: 'auth.reset' })
    expect(thReset('busy', { seconds: 7 })).toBe('ยังไม่ได้บันทึกรหัสผ่านใหม่ เพราะมีคำขอจากเครือข่ายนี้ถี่เกินไป ลิงก์ยังใช้ได้ รอ 7 วินาทีแล้วกด บันทึกรหัสผ่านใหม่ อีกครั้ง')
    expect(thReset('busy', { seconds: 0 })).toContain('ลิงก์ยังใช้ได้ รอสักครู่แล้วกด บันทึกรหัสผ่านใหม่ อีกครั้ง')
    expect(enReset('busy', { seconds: 7 })).toContain('The link still works. Wait 7 seconds, then press Save new password again.')
    expect(enReset('busy', { seconds: 1 })).toContain('Wait 1 second, then')
    expect(enReset('busy', { seconds: 0 })).toContain('Wait a moment, then')
    expect(thReset('busy', { seconds: 7 })).not.toContain('การเชื่อมต่อ')
  })
})

describe('[FR-AUTH-002/AC1] the authenticator setup: too many requests, an ended session or a setup done elsewhere is not a wrong password', () => {
  it.each<[AuthFailure, SetupRefusal]>([
    // No answer or a server failure
    [{ status: 0 }, 'failed'],
    [{}, 'failed'],
    [{ status: 503 }, 'failed'],
    // Better Auth's limit on its two-factor routes (3 in 10 s from one address), checked before the password
    [{ status: 429 }, 'busy'],
    // No session any more
    [{ status: 401, code: 'UNAUTHORIZED' }, 'signedOut'],
    // Set up already, in another tab
    [{ status: 400, code: 'TOTP_ALREADY_ENABLED' }, 'alreadyOn'],
    // The password refused: wrong, or too long to be anyone's
    [{ status: 400, code: 'INVALID_PASSWORD' }, 'wrongPassword'],
    [{ status: 400, code: 'PASSWORD_TOO_LONG' }, 'wrongPassword'],
    // Anything else is not called a wrong password
    [{ status: 403, code: 'INVALID_ORIGIN' }, 'refused'],
    [{ status: 400, code: 'VALIDATION_ERROR' }, 'refused'],
  ])('the password step: %o is %s', (failure, refusal) => {
    expect(setupPasswordRefusal(failure)).toBe(refusal)
  })

  it.each<[AuthFailure, SetupRefusal]>([
    [{ status: 0 }, 'failed'],
    [{ status: 500 }, 'failed'],
    [{ status: 429 }, 'busy'],
    // No session: Better Auth looks for a sign-in waiting for its second step and finds none
    [{ status: 401, code: 'INVALID_TWO_FACTOR_COOKIE' }, 'signedOut'],
    [{ status: 401, code: 'INVALID_CODE' }, 'invalidCode'],
    [{ status: 400, code: 'TOTP_NOT_ENABLED' }, 'refused'],
  ])('the code step: %o is %s', (failure, refusal) => {
    expect(setupCodeRefusal(failure)).toBe(refusal)
  })

  it('only the words of a refused password or code say it was wrong; too many requests says how long to wait', () => {
    const thSecurity = createTranslator({ locale: 'th', messages: th, namespace: 'auth.security' })
    const enSecurity = createTranslator({ locale: 'en', messages: en, namespace: 'auth.security' })
    expect(th.auth.security.wrongPassword).toContain('ไม่ถูกต้อง')
    for (const key of ['failed', 'signedOut', 'alreadyOn', 'refused', 'passwordRequired'] as const) {
      expect(th.auth.security[key], key).not.toContain('ไม่ถูกต้อง')
      expect(en.auth.security[key], key).not.toMatch(/not correct|wrong/i)
    }
    expect(thSecurity('busy', { seconds: 8 })).toBe('ยังไม่ได้ตรวจสิ่งที่กรอก เพราะมีคำขอจากเครือข่ายนี้ถี่เกินไป รอ 8 วินาทีแล้วลองอีกครั้ง')
    expect(thSecurity('busy', { seconds: 0 })).toContain('รอสักครู่แล้วลองอีกครั้ง')
    expect(enSecurity('busy', { seconds: 8 })).toBe('What you entered was not checked: too many requests came from this network in a short time. Wait 8 seconds, then try again.')
    expect(enSecurity('busy', { seconds: 0 })).toContain('Wait a moment, then try again.')
    for (const words of [thSecurity('busy', { seconds: 8 }), enSecurity('busy', { seconds: 8 })]) expect(words).not.toMatch(/ไม่ถูกต้อง|not correct|wrong/i)
  })
})

describe('[FR-AUTH-001/AC2] [FR-AUTH-002/AC1] how long a refused request asks to wait', () => {
  it.each<[Record<string, string>, number | null]>([
    // Better Auth's limit on requests sends the seconds in X-Retry-After
    [{ 'X-Retry-After': '7' }, 7],
    [{ 'X-Retry-After': '10' }, 10],
    // Never "wait 0 seconds"
    [{ 'X-Retry-After': '0' }, 1],
    // HTTP's own header, in seconds
    [{ 'Retry-After': '30' }, 30],
    [{ 'X-Retry-After': '9', 'Retry-After': '30' }, 9],
    // Not a number of whole seconds: the words say to wait a moment
    [{ 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, null],
    [{ 'X-Retry-After': '-3' }, null],
    [{ 'X-Retry-After': '1.5' }, null],
    [{ 'X-Retry-After': 'soon' }, null],
    [{}, null],
  ])('%o waits %s', (headers, seconds) => {
    expect(retryAfterSeconds(new Headers(headers))).toBe(seconds)
  })

  it('settledWithWait reads the wait from the answer the client hands its hooks, and settles without one', async () => {
    const limited = await settledWithWait(async (hooks) => {
      hooks.onError({ response: new Response(null, { status: 429, headers: { 'X-Retry-After': '9' } }) })
      return { data: null, error: { status: 429, statusText: 'Too Many Requests' } }
    })
    expect(limited).toEqual({ answer: { data: null, error: { status: 429, statusText: 'Too Many Requests' } }, retryAfter: 9 })
    const lost = await settledWithWait(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(lost).toEqual({ answer: { data: null, error: { status: 0, statusText: '' } }, retryAfter: null })
    const fine = await settledWithWait(async () => ({ data: { status: true }, error: null }))
    expect(fine.retryAfter).toBeNull()
  })

  it('with Better Auth’s own browser client: a 429 of its limit comes back with its wait, a refused password with its code', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost:3000')
    const asked: string[] = []
    let next: Response = new Response()
    vi.stubGlobal('fetch', async (input: unknown) => {
      asked.push(String(input instanceof Request ? input.url : input))
      return next
    })
    vi.resetModules()
    const { authClient, settledWithWait: withWait } = await import('@/ui/auth/client')
    const json = { 'content-type': 'application/json' }

    next = new Response(JSON.stringify({ message: 'Too many requests. Please try again later.' }), { status: 429, statusText: 'Too Many Requests', headers: { ...json, 'X-Retry-After': '6' } })
    const reset = await withWait((hooks) => authClient.resetPassword({ newPassword: 'a-long-new-password-1', token: 'not-a-token' }, hooks))
    expect(reset.retryAfter).toBe(6)
    expect(resetRefusal(reset.answer.error!)).toBe('busy')

    next = new Response(JSON.stringify({ message: 'Too many requests. Please try again later.' }), { status: 429, statusText: 'Too Many Requests', headers: { ...json, 'X-Retry-After': '4' } })
    const setup = await withWait((hooks) => authClient.twoFactor.enable({ password: 'the-password-of-this-member' }, hooks))
    expect(setup.retryAfter).toBe(4)
    expect(setupPasswordRefusal(setup.answer.error!)).toBe('busy')

    next = new Response(JSON.stringify({ code: 'PASSWORD_TOO_LONG', message: 'Password too long' }), { status: 400, statusText: 'Bad Request', headers: json })
    const tooLong = await withWait((hooks) => authClient.resetPassword({ newPassword: 'x'.repeat(PASSWORD_MAX_LENGTH + 1), token: 'a-token' }, hooks))
    expect(tooLong.retryAfter).toBeNull()
    expect(resetRefusal(tooLong.answer.error!)).toBe('tooLong')

    expect(asked).toEqual(['http://localhost:3000/api/auth/reset-password', 'http://localhost:3000/api/auth/two-factor/enable', 'http://localhost:3000/api/auth/reset-password'])
  })
})
