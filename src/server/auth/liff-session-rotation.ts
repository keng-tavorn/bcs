import { APIError, createAuthEndpoint, isAPIError, type DispatchContext } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { systemClock } from '@/lib/clock'
import { systemDb } from '@/server/db/system'
import { auth } from './auth'
import { isLiffSessionToken, liffSessionIdentityId, newLiffSessionToken } from './liff'
import type { SignedInSession } from './session-rotation'

// NFR-SEC-04 for a session opened from a LIFF ID token (§9.4, ADR-046, ADR-047): once the member proved the PIN for a
// decision on a LIFF page (FR-AUTH-005 AC2, FR-LINE-003 AC2), the session the LINE app holds gets a new token — the
// session id its cookie carries — as ./session-rotation.ts does for a password session: one conditional update of the
// session's row, after which the old token opens nothing; the row keeps the sign-in's time and absolute end (createdAt
// and expiresAt, FR-AUTH-003 AC1), and the step-up is activity, so its idle clock starts again. Two step-ups of one
// session at the same moment change it once; the other one proved the PIN too, so it gets the token now in force.
// The new token is made the way the sign-in makes one (liff.ts newLiffSessionToken) and names the same LINE link: the
// session still serves LIFF pages only, with their 15-minute idle limit (liff.ts, session.ts), and still ends with that
// link. A LIFF token that names no link (opened before sessions were bound to one) is not rotated: no page accepts it.
// A password session is left to ./session-rotation.ts.
// It runs as a server-only endpoint of Better Auth — never reachable over HTTP — called directly instead of dispatched:
// the liffIdToken plugin refuses every dispatched endpoint to a LIFF session except its own few (liff.ts
// LIFF_SESSION_ALLOWED_PATHS, which keeps a LINE login away from the endpoints that would make it a workspace login),
// and this one only gives the very session the request holds a new token. Called directly, Better Auth's hooks do not
// run, so nextCookies() does not write the new cookie into the response: the caller does, from `setCookie` — the
// Set-Cookie lines Better Auth wrote with setSessionCookie. Nothing here logs or returns a token.

const NO_SESSION = 'NO_SESSION'
const NOT_LIFF = 'NOT_LIFF'

/**
 * The token another step-up of the same session gave it after this request came with `token` (two tabs at once): only
 * when `token` opens no session any more and the session named is the request's own, live, and still a LIFF one of the
 * same LINE link
 */
async function liffTokenInForce(token: string, identityId: string, signedIn: SignedInSession, now: Date): Promise<string | null> {
  if (await systemDb.session.findUnique({ where: { token }, select: { id: true } })) return null
  const row = await systemDb.session.findFirst({ where: { id: signedIn.sessionId, userId: signedIn.userId, expiresAt: { gt: now } }, select: { token: true } })
  return row && liffSessionIdentityId(row.token) === identityId ? row.token : null
}

const rotateLiffSessionEndpoint = createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
  const body = ctx.body as Partial<Record<keyof SignedInSession, unknown>> | undefined
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret)
  if (!sessionId || !userId || typeof token !== 'string' || !token) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  // A password session changes through ./session-rotation.ts, with Better Auth's own token format
  if (!isLiffSessionToken(token)) throw new APIError('FORBIDDEN', { message: NOT_LIFF })
  // A LIFF token that names no link opens no page (resolveSession ends it): there is no session to give a new token
  const identityId = liffSessionIdentityId(token)
  if (!identityId) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  // Session limits run on real time, the security clock (session.ts)
  const now = systemClock.now()
  const fresh = newLiffSessionToken(identityId)
  // One conditional update: of two step-ups of this session at once, only the one whose token is still the session's wins
  const { count } = await systemDb.session.updateMany({
    where: { id: sessionId, userId, token, expiresAt: { gt: now } },
    data: { token: fresh, lastActiveAt: now, updatedAt: now },
  })
  const current = count === 1 ? fresh : await liffTokenInForce(token, identityId, { sessionId, userId }, now)
  if (!current) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  // Sessions of this identity that have ended go too, as the password session's rotation does
  await systemDb.session.deleteMany({ where: { userId, expiresAt: { lte: now } } })
  const session = await ctx.context.internalAdapter.findSession(current)
  if (!session) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  await setSessionCookie(ctx, session)
  return ctx.json({ ok: true })
})

export type LiffSessionRotation =
  | { readonly ok: true; readonly setCookie: readonly string[] }
  /** NO_SESSION: the request holds no live session (ended, signed out, another one) · NOT_LIFF: a password session */
  | { readonly ok: false; readonly reason: 'NO_SESSION' | 'NOT_LIFF' }

/**
 * NFR-SEC-04: gives the LIFF session of this request a new token after a right PIN (see above). `signedIn` is the session
 * the request was resolved to (resolveSession: SessionState sessionId and userId), never anything the browser sent. The
 * caller writes `setCookie` into its response (a server action: Next.js's cookies()).
 */
export async function rotateLiffSessionAfterStepUp(headers: Headers, signedIn: SignedInSession): Promise<LiffSessionRotation> {
  // auth.$context is the AuthContext of this auth instance, typed to our options; the endpoint takes the general one. A
  // copy of it per call, as Better Auth's dispatcher makes one, so nothing this call sets on it reaches another request
  const shared = (await auth.$context) as unknown as DispatchContext['context']
  const context = { ...shared, returned: undefined, responseHeaders: undefined, session: null }
  const body: SignedInSession = { sessionId: signedIn.sessionId, userId: signedIn.userId }
  try {
    const result = (await rotateLiffSessionEndpoint({ headers, body, context, returnHeaders: true } as unknown as Parameters<typeof rotateLiffSessionEndpoint>[0])) as {
      headers?: Headers | null
    }
    return { ok: true, setCookie: result.headers?.getSetCookie() ?? [] }
  } catch (error) {
    if (!isAPIError(error)) throw error
    return { ok: false, reason: error.message === NOT_LIFF ? 'NOT_LIFF' : 'NO_SESSION' }
  }
}
