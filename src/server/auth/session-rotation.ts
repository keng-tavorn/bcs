import { APIError, createAuthEndpoint, dispatchAuthEndpoint, isAPIError, type DispatchContext } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { generateRandomString } from 'better-auth/crypto'
import { systemClock } from '@/lib/clock'
import { systemDb } from '@/server/db/system'
import { auth } from './auth'
import { isLiffSessionToken } from './liff'

// NFR-SEC-04: the session id changes after a step-up (and after a login, which Better Auth does itself). Once the member
// proved the PIN for a decision, the session the browser holds gets a new token — the session id its cookie carries —
// in one conditional update of the session's row, and the old token opens nothing from then on. The row stays, with the
// sign-in's time and absolute end (createdAt and expiresAt, FR-AUTH-003 AC1: a step-up never makes a session live
// longer), so the devices list (FR-AUTH-003 AC3) keeps one row for the browser; the step-up is activity, so its idle
// clock (lastActiveAt) starts again.
// Two step-ups of one session at the same moment (two tabs of one browser) change it once: the update names the token
// the request came with, so only one of them matches it. The other one proved the PIN too, so its response carries the
// token now in force instead of signing the browser out. A session that ended, or was signed out, is no session. The
// identity's sessions that have ended are deleted on the way, so the devices list holds live sessions only.
// The page the server action renders again in the same request reads the new cookie (src/app/_lib/session.ts).
// It runs as an endpoint of Better Auth's own pipeline (a server-only endpoint, never reachable over HTTP, dispatched
// with dispatchAuthEndpoint, Better Auth's supported way to run an endpoint from server code): the hooks of auth.ts run
// for it, so in a server action the nextCookies() plugin writes the new cookie into the response, and the liffIdToken
// plugin refuses a session opened from a LIFF ID token, which only a new ID token renews (liff.ts).

/** Better Auth's own session tokens: 32 letters and digits (generateId of @better-auth/core), never the LIFF prefix */
const SESSION_TOKEN_LENGTH = 32

const NO_SESSION = 'NO_SESSION'

/** The session the request was signed in with, as resolveSession found it at the start of the request */
export interface SignedInSession {
  readonly sessionId: string
  readonly userId: string
}

/**
 * The token another step-up of the same session gave it after this request came with `token` (two tabs at once): only
 * when `token` opens no session any more and the session named is the request's own, live
 */
async function tokenInForce(token: string, signedIn: SignedInSession, now: Date): Promise<string | null> {
  // The request's token still names a session — one that ended, or not the one named: nothing is handed over
  if (await systemDb.session.findUnique({ where: { token }, select: { id: true } })) return null
  const row = await systemDb.session.findFirst({ where: { id: signedIn.sessionId, userId: signedIn.userId, expiresAt: { gt: now } }, select: { token: true } })
  return row && !isLiffSessionToken(row.token) ? row.token : null
}

const rotateSessionEndpoint = createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
  const body = ctx.body as Partial<Record<keyof SignedInSession, unknown>> | undefined
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const userId = typeof body?.userId === 'string' ? body.userId : ''
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret)
  if (!sessionId || !userId || typeof token !== 'string' || !token) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  // A LIFF session is renewed by a new LINE ID token only (the liffIdToken hook refuses it before this runs)
  if (isLiffSessionToken(token)) throw new APIError('FORBIDDEN', { message: 'LIFF_SESSION' })
  // Session limits run on real time, the security clock (session.ts)
  const now = systemClock.now()
  const fresh = generateRandomString(SESSION_TOKEN_LENGTH, 'a-z', 'A-Z', '0-9')
  // One conditional update: of two step-ups of this session at once, only the one whose token is still the session's wins
  const { count } = await systemDb.session.updateMany({
    where: { id: sessionId, userId, token, expiresAt: { gt: now } },
    data: { token: fresh, lastActiveAt: now, updatedAt: now },
  })
  const current = count === 1 ? fresh : await tokenInForce(token, { sessionId, userId }, now)
  if (!current) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  // Sessions of this identity that have ended are gone too, so the devices list shows live ones only (FR-AUTH-003 AC3)
  await systemDb.session.deleteMany({ where: { userId, expiresAt: { lte: now } } })
  const session = await ctx.context.internalAdapter.findSession(current)
  if (!session) throw new APIError('UNAUTHORIZED', { message: NO_SESSION })
  await setSessionCookie(ctx, session)
  return ctx.json({ ok: true })
})

export type SessionRotation =
  | { readonly ok: true; readonly setCookie: readonly string[] }
  /** NO_SESSION: the request holds no live session (ended, signed out) · REFUSED: Better Auth refused it (a LIFF session) */
  | { readonly ok: false; readonly reason: 'NO_SESSION' | 'REFUSED' }

/**
 * NFR-SEC-04: gives the browser of this request a new session id after a right PIN (see above). `signedIn` is the session
 * the request was resolved to (resolveSession: SessionState sessionId and userId), never anything the browser sent. In a
 * server action the new cookie goes into the response; setCookie returns the Set-Cookie lines for callers outside one.
 */
export async function rotateSessionAfterStepUp(headers: Headers, signedIn: SignedInSession): Promise<SessionRotation> {
  try {
    // auth.$context is the AuthContext of this auth instance: its type is narrowed to our options, where the dispatcher
    // takes the general one (the same object toAuthEndpoints hands it for auth.api calls)
    const context = (await auth.$context) as unknown as DispatchContext['context']
    const body: SignedInSession = { sessionId: signedIn.sessionId, userId: signedIn.userId }
    const result = (await dispatchAuthEndpoint(rotateSessionEndpoint, { headers, context, body, returnHeaders: true })) as { headers?: Headers | null }
    return { ok: true, setCookie: result.headers?.getSetCookie() ?? [] }
  } catch (error) {
    if (!isAPIError(error)) throw error
    return { ok: false, reason: error.message === NO_SESSION ? 'NO_SESSION' : 'REFUSED' }
  }
}
