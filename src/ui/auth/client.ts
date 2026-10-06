import { twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { retryAfterSeconds } from './answers'

// Browser client for Better Auth's endpoints under /api/auth (same origin). Sign-in, the 2FA step, password reset
// and authenticator setup go through it; everything about organizations goes through our own server actions.
export const authClient = createAuthClient({ plugins: [twoFactorClient()] })

// What an answer means lives in ./answers.ts, which has no client (the LIFF sign-in reads it too)
export { errorStatus, failedToAnswer } from './answers'

/** What a call of the auth client gives when no answer came back: an error of status 0, as errorStatus reads none */
export interface NoAnswer {
  readonly data: null
  readonly error: { readonly status: 0; readonly statusText: string; readonly code?: undefined; readonly message?: undefined }
}

const NO_ANSWER: NoAnswer = { data: null, error: { status: 0, statusText: '' } }

/**
 * A call of the auth client that always settles with its { data, error }. A request that gets no answer (the connection
 * dropped, the server could not be reached) makes fetch throw, and neither better-fetch nor Better Auth's client catches
 * it: a form awaiting the call would stay busy for good and say nothing (§9.9 rule 7). It comes back as an error of
 * status 0 instead, which the forms word as a failed connection (failedToAnswer).
 */
export async function settled<T>(call: Promise<T>): Promise<T | NoAnswer> {
  try {
    return await call
  } catch {
    return NO_ANSWER
  }
}

/** The fetch options settledWithWait hands the call: Better Auth's client runs onError with a refused request's answer */
export interface WaitHooks {
  readonly onError: (context: { readonly response: Response }) => void
}

/**
 * settled, and the seconds a refused call asks to wait before the next try. Better Auth's limit on requests answers 429
 * with them in a header (X-Retry-After) and no code, and the error the client gives back has no headers: so the call
 * reads them on the way, through the hooks it is handed. retryAfter is null when the answer did not say.
 */
export async function settledWithWait<T>(call: (hooks: WaitHooks) => Promise<T>): Promise<{ readonly answer: T | NoAnswer; readonly retryAfter: number | null }> {
  let retryAfter: number | null = null
  const answer = await settled(
    call({
      onError: ({ response }) => {
        retryAfter = retryAfterSeconds(response.headers)
      },
    }),
  )
  return { answer, retryAfter }
}
