// What Better Auth's answers to the calls of the sign-in pages mean, so that each form says what really happened and how
// to fix it (§9.9 rule 7), never a cause it does not know: a request that got no answer is not a wrong password, a limit
// on requests is not a wrong password, and a password too long is not an expired link. The forms: the web sign-in and the
// sign-in inside LIFF (FR-AUTH-001, FR-LINE-001 AC2), the new password from the e-mailed link (FR-AUTH-001 AC2) and the
// authenticator setup (FR-AUTH-002 AC1). Plain functions without the client: the LIFF sign-in reads them too, and its
// JavaScript counts in the 200 KB gzip of a LIFF page with the LINE SDK (§9.4, ADR-052), which Better Auth's browser
// client (./client.ts) would add some 13 KB to. tests/unit/auth-answers.test.ts holds every answer each form tells
// apart; tests/integration/auth-answers.test.ts that Better Auth answers so.

/** A refused call as a form reads it: the HTTP status (none or 0: no answer came back) and Better Auth's code */
export interface AuthFailure {
  readonly status?: number
  readonly code?: string
}

const BAD_REQUEST_STATUS = 400
const UNAUTHORIZED_STATUS = 401
/** Our sign-in lockout (LOGIN_LOCKED, with its reason and end) and Better Auth's limit on requests (no code) */
const TOO_MANY_REQUESTS_STATUS = 429
/** The lowest status of a server that failed (5xx): nothing was decided about what was sent */
const SERVER_ERROR_STATUS = 500

/** Better Auth's codes the forms tell apart (@better-auth/core BASE_ERROR_CODES, the two-factor plugin's codes) */
const INVALID_EMAIL = 'INVALID_EMAIL'
const INVALID_PASSWORD = 'INVALID_PASSWORD'
const PASSWORD_TOO_SHORT = 'PASSWORD_TOO_SHORT'
const PASSWORD_TOO_LONG = 'PASSWORD_TOO_LONG'
const INVALID_CODE = 'INVALID_CODE'
const INVALID_TWO_FACTOR_COOKIE = 'INVALID_TWO_FACTOR_COOKIE'
const TOTP_ALREADY_ENABLED = 'TOTP_ALREADY_ENABLED'

export function errorStatus(error: { status?: number } | null | undefined): number {
  return error?.status ?? 0
}

/**
 * The request got no answer, or the server failed (5xx): what was sent was neither accepted nor refused, so the form
 * says to send it again — never that the password, the code or the link was wrong. serverFailed tells the two apart.
 */
export function failedToAnswer(error: { status?: number }): boolean {
  return errorStatus(error) === 0 || serverFailed(error)
}

/**
 * The server failed (5xx): the request reached BCS, which failed before it decided on what was sent — so the form says
 * to wait a moment and send it again, never to check the connection, which worked
 */
export function serverFailed(error: { status?: number }): boolean {
  return errorStatus(error) >= SERVER_ERROR_STATUS
}

/** How a sign-in form words a first step that did not sign in */
export type SignInRefusal = 'emailInvalid' | 'locked' | 'invalid' | 'failed' | 'serverFailed'

/**
 * Why the first step did not sign in, from Better Auth's answer: no answer (check the connection and send again), a
 * server failure (5xx: the request reached BCS, which failed before it checked the e-mail and password — wait and send
 * again, never "check your connection", which worked), a lock (its own words, lock-message.ts), an address that is not
 * an e-mail (on the e-mail field), or anything else the server refused — a wrong e-mail or password, a password too long
 * to be anyone's — without saying which part was wrong (FR-AUTH-001 AC3)
 */
export function signInRefusal(failure: AuthFailure): SignInRefusal {
  const status = errorStatus(failure)
  if (status === 0) return 'failed'
  if (serverFailed(failure)) return 'serverFailed'
  if (status === TOO_MANY_REQUESTS_STATUS) return 'locked'
  if (status === BAD_REQUEST_STATUS && failure.code === INVALID_EMAIL) return 'emailInvalid'
  return 'invalid'
}

/** How a sign-in form words a code of the second step that did not sign in */
export type SecondStepRefusal = 'expired' | 'failed' | 'locked' | 'invalid'

/**
 * Why a code of the second step did not sign in: the step waited too long (Better Auth no longer knows the sign-in the
 * code is for, so it starts again with the password), no answer or a server failure (the code was not checked: the
 * form words each its own way, with serverFailed), a lock (its own words), or a code that is wrong, expired or used
 */
export function secondStepRefusal(failure: AuthFailure): SecondStepRefusal {
  if (failure.code === INVALID_TWO_FACTOR_COOKIE) return 'expired'
  if (failedToAnswer(failure)) return 'failed'
  if (errorStatus(failure) === TOO_MANY_REQUESTS_STATUS) return 'locked'
  return 'invalid'
}

/** How the new-password form words a new password that was not saved */
export type ResetRefusal = 'failed' | 'busy' | 'tooShort' | 'tooLong' | 'linkInvalid'

/**
 * Why the new password from the e-mailed link was not saved. No answer, a server failure or too many requests (Better
 * Auth's limit, before anything is read): the link was not used, so the form stays and says to send again. A password
 * shorter or longer than the rule: on the password field — Better Auth checks the length before it uses the link, which
 * still works. Only a link Better Auth does not take (expired, used or never issued: INVALID_TOKEN, or an account that
 * is gone) is called expired or used, with the way to a new one.
 */
export function resetRefusal(failure: AuthFailure): ResetRefusal {
  if (failedToAnswer(failure)) return 'failed'
  const status = errorStatus(failure)
  if (status === TOO_MANY_REQUESTS_STATUS) return 'busy'
  if (status === BAD_REQUEST_STATUS && failure.code === PASSWORD_TOO_SHORT) return 'tooShort'
  if (status === BAD_REQUEST_STATUS && failure.code === PASSWORD_TOO_LONG) return 'tooLong'
  return 'linkInvalid'
}

/** How the authenticator setup words a step that did not go through */
export type SetupRefusal = 'failed' | 'busy' | 'signedOut' | 'alreadyOn' | 'wrongPassword' | 'invalidCode' | 'refused'

/**
 * Why the password step of the authenticator setup (POST /two-factor/enable) did not go through. No answer or a server
 * failure; too many requests from this address (Better Auth's limit on its two-factor routes, checked before the
 * password); no session any more (it ended, or was signed out elsewhere); the setup already done (in another tab); the
 * password refused — wrong, or too long to be anyone's. Anything else is not called a wrong password: the form says the
 * setup did not go through and to reload.
 */
export function setupPasswordRefusal(failure: AuthFailure): SetupRefusal {
  if (failedToAnswer(failure)) return 'failed'
  const status = errorStatus(failure)
  if (status === TOO_MANY_REQUESTS_STATUS) return 'busy'
  if (status === UNAUTHORIZED_STATUS) return 'signedOut'
  if (status === BAD_REQUEST_STATUS && failure.code === TOTP_ALREADY_ENABLED) return 'alreadyOn'
  if (status === BAD_REQUEST_STATUS && (failure.code === INVALID_PASSWORD || failure.code === PASSWORD_TOO_LONG)) return 'wrongPassword'
  return 'refused'
}

/**
 * Why the code step of the authenticator setup (POST /two-factor/verify-totp with the session of the member setting up)
 * did not turn it on: no answer or a server failure, too many requests, no session any more (Better Auth then looks for
 * a sign-in waiting for its second step and finds none), a code that is wrong or expired, or anything else (reload)
 */
export function setupCodeRefusal(failure: AuthFailure): SetupRefusal {
  if (failedToAnswer(failure)) return 'failed'
  const status = errorStatus(failure)
  if (status === TOO_MANY_REQUESTS_STATUS) return 'busy'
  if (failure.code === INVALID_TWO_FACTOR_COOKIE) return 'signedOut'
  if (failure.code === INVALID_CODE) return 'invalidCode'
  return 'refused'
}

/** Our sign-in lockout (src/server/auth/auth.ts): 429 with this code, its reason (ACCOUNT or IP) and when it lifts */
const LOGIN_LOCKED = 'LOGIN_LOCKED'
/**
 * Better Auth's own lock of the second sign-in step (its two-factor plugin's accountLockout: TWO_FACTOR_LOCK_LIMIT wrong
 * codes in a row pause the account's second step, the right code and backup codes too): 429 with this code
 */
export const SECOND_STEP_LOCKED = 'ACCOUNT_TEMPORARILY_LOCKED'

/** The words of a refused sign-in step's lock (keys under auth.lock) */
export type LockWords = 'account' | 'address' | 'secondStep' | 'busy'

/**
 * Which lock refused a sign-in step (429), so that its words say which one and when it lifts (§9.9 rule 7): ours, of this
 * account or of this network address, with its end time; Better Auth's lock of the second step, which comes after ours
 * once the wrong codes go on (a member who waited out ours is never told they are going too fast); anything else is a
 * plain limit on requests. The web pages (./lock-message.ts) and the LIFF sign-in fill in the values.
 */
export function lockWords(failure: { readonly code?: string; readonly reason?: unknown; readonly retryAt?: unknown }): LockWords {
  if (failure.code === SECOND_STEP_LOCKED) return 'secondStep'
  const retryAt = typeof failure.retryAt === 'string' ? new Date(failure.retryAt) : null
  if (failure.code !== LOGIN_LOCKED || !retryAt || Number.isNaN(retryAt.getTime())) return 'busy'
  return failure.reason === 'IP' ? 'address' : 'account'
}

/** Where an answer says how many seconds to wait: Better Auth's limit on requests uses the first, HTTP the second */
const RETRY_AFTER_HEADERS = ['X-Retry-After', 'Retry-After'] as const
const WHOLE_SECONDS = /^\d+$/

/**
 * The whole seconds a refused request asks to wait before the next try, at least 1; null when the answer does not say
 * (Retry-After as a date is not read: the words then say to wait a moment)
 */
export function retryAfterSeconds(headers: { get(name: string): string | null }): number | null {
  for (const name of RETRY_AFTER_HEADERS) {
    const value = headers.get(name)?.trim()
    if (value && WHOLE_SECONDS.test(value)) return Math.max(1, Number(value))
  }
  return null
}
