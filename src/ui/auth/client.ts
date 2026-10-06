import { twoFactorClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

// Browser client for Better Auth's endpoints under /api/auth (same origin). Sign-in, the 2FA step, password reset
// and authenticator setup go through it; everything about organizations goes through our own server actions.
export const authClient = createAuthClient({ plugins: [twoFactorClient()] })

/** The lowest status of a server that failed (5xx): nothing was decided about what was sent */
const SERVER_ERROR_STATUS = 500

export function errorStatus(error: { status?: number } | null | undefined): number {
  return error?.status ?? 0
}

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

/**
 * The request got no answer, or the server failed (5xx): what was sent was neither accepted nor refused, so the form
 * says to check the connection and send it again — never that the password, the code or the link was wrong
 */
export function failedToAnswer(error: { status?: number }): boolean {
  const status = errorStatus(error)
  return status === 0 || status >= SERVER_ERROR_STATUS
}
