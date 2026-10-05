import { cookies, headers } from 'next/headers'
import { cache } from 'react'
import { resolvePlatformSession, resolveSession } from '@/server/auth/session'
import { withHeldCookies } from './held-cookies'

/**
 * The request's headers with its cookies as they are now. A server action that sets a cookie — a new session id after a
 * PIN step-up (NFR-SEC-04, src/server/auth/session-rotation.ts) — has its page rendered again in the same request, and
 * Next.js updates cookies() for that render but not the Cookie header of headers() (synchronizeMutableCookies in
 * next/dist/server/async-storage/request-store.js). Read from the header, the session would be the one the action just
 * ended, and the member would be sent to the sign-in page. Outside an action both hold the same cookies. Each value is
 * written URI-encoded, as a browser sends what a Set-Cookie gave it (Better Auth decodes it again); a cookie the action
 * deleted has an empty value and is left out (withHeldCookies, tested with Next.js's own cookie stores).
 */
async function currentHeaders(): Promise<Headers> {
  const [incoming, jar] = await Promise.all([headers(), cookies()])
  return withHeldCookies(incoming, jar.getAll())
}

// One session lookup per request, shared by the layout and the page (resolveSession also refreshes lastActiveAt).
export const getSession = cache(async () => resolveSession(await currentHeaders()))

// The BCS team's session for /platform/* (an active PlatformAdmin row for the signed-in identity).
export const getPlatformSession = cache(async () => resolvePlatformSession(await currentHeaders()))
