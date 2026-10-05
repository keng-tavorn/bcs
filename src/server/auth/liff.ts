import { randomBytes } from 'node:crypto'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint, createAuthMiddleware, formCsrfMiddleware } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { LIFF_ID_TOKEN_MAX_LENGTH, MS_PER_SECOND, SESSION_ABSOLUTE_MS, SESSION_IDLE_LIFF_MS, SESSION_IDLE_WEB_MS } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { logger } from '@/lib/logger'
import { systemDb } from '@/server/db/system'
import { recordAuthEvent } from './auth-events'
import { clientIp, ipPrefix, normalizeEmail } from './lockout'

// LIFF sign-in (BR-LINE-01, BR-LINE-02): the LIFF page sends liff.getIDToken() to POST /api/liff/session (§9.1), which
// hands it to this plugin's endpoint (/api/auth/liff/session, ADR-040). The server asks LINE's verify endpoint with the
// channel that issued the LIFF app (LINE_LIFF_CHANNEL_ID), checks iss, aud and exp itself (Better Auth's LINE provider is
// not used: MINI App tokens carry a different aud), and uses `sub` as the LINE user id. Nothing the client says about the
// user is trusted.
//
// Session policy (S5-03, §9.4, FR-AUTH-003 AC1). A LIFF session stands for a LINE login only — no password, no TOTP:
//  - who: the LINE user must be linked — a live ChannelIdentity under the channel's provider — to an ACTIVE member of an
//    ACTIVE organization whose LINE channel is switched on and uses this LIFF channel. Otherwise 403 LINK_REQUIRED (the
//    LIFF page sends the user to /liff/link). A LINE account linked to members of two different sign-in identities is
//    refused (LINK_AMBIGUOUS) rather than guessed.
//  - bound to the link it was opened with: the session's token names that ChannelIdentity —
//    liff_<ChannelIdentity id>.<random> (newLiffSessionToken; no migration: ADR-046 keeps "a Session column" for later).
//    On every request it acts only as that link's member, and only while that very link stands as a sign-in requires
//    (liffSessionMemberIds, read by resolveSession, and the Better Auth endpoints a LIFF session may reach). A link ended
//    (on the web, in LIFF, by a deactivation), a channel switched off or another LIFF channel ends the session at its
//    next request, and a newer link of the same member — another phone's LINE account — never brings it back. A token
//    that names no link (a session opened before sessions were bound) is refused and ended the same way. Another
//    organization of the same person is never reached through LINE: the session is one link's, so one member's. The
//    unlink command also ends the member's LIFF sessions in its own transaction (src/server/db/sql/identity.ts).
//  - where: the session's token starts with LIFF_SESSION_TOKEN_PREFIX. resolveSession (session.ts) accepts it for LIFF
//    pages only, with the LIFF idle limit (15 minutes): a LINE login never opens the workspace, whose roles ask for a
//    password and TOTP (FR-AUTH-002 AC1). Better Auth's own endpoints refuse it too, except the few in
//    LIFF_SESSION_ALLOWED_PATHS: changing the password, setting up TOTP or listing sessions would turn it into a
//    workspace login or a way round the sign-in lockout. A web session still works on LIFF pages opened in a browser.
//  - renewal: the LIFF page sends a new ID token when its session ended (idle) or is about to; a new session replaces the
//    one the browser holds, which is deleted, so renewals leave nothing behind — but never a live session of another
//    sign-in identity (someone else's sign-in in this LINE browser, with a password or through LINE): that sign-in is
//    refused (403 SIGNED_IN_AS_ANOTHER_USER) and the other session and its cookie stay as they are. A session that has
//    ended — past the limits resolveSession counts (sessionPastItsLimits), or a LIFF session whose link is gone — is no
//    sign-in to keep, whoever's it was: it is replaced.
//  - audit: every sign-in through LINE is recorded like a web sign-in (auth.login_succeeded / auth.login_failed, step
//    liff, channel LIFF), with the reason when it is refused; never the token or the LINE user id.

export const LINE_ID_TOKEN_ISSUER = 'https://access.line.me'
const VERIFY_TIMEOUT_MS = 5 * MS_PER_SECOND

/** Test seam: replace the channel id and the HTTP call to LINE (null restores the environment). */
let override: { channelId?: string; fetch?: typeof fetch } | null = null
export function setLiffVerification(value: { channelId?: string; fetch?: typeof fetch } | null): void {
  override = value
}

export type LiffVerification = { ok: true; lineUserId: string } | { ok: false; reason: 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'INVALID' }

export async function verifyLiffIdToken(idToken: string, now: Date): Promise<LiffVerification> {
  const env = getEnv()
  const channelId = override?.channelId ?? env.LINE_LIFF_CHANNEL_ID
  if (!channelId) return { ok: false, reason: 'NOT_CONFIGURED' }
  const doFetch = override?.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(`${env.LINE_API_BASE_URL}/oauth2/v2.1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'UNAVAILABLE' }
  }
  if (response.status >= 500) return { ok: false, reason: 'UNAVAILABLE' }
  if (!response.ok) return { ok: false, reason: 'INVALID' }
  const claims = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const valid =
    claims.iss === LINE_ID_TOKEN_ISSUER &&
    claims.aud === channelId &&
    typeof claims.sub === 'string' &&
    claims.sub.length > 0 &&
    typeof claims.exp === 'number' &&
    claims.exp * MS_PER_SECOND > now.getTime()
  return valid ? { ok: true, lineUserId: claims.sub as string } : { ok: false, reason: 'INVALID' }
}

// ---------- session policy (S5-03) ----------

/** The plugin's endpoint under Better Auth's base path (/api/auth); POST /api/liff/session hands requests to it */
export const LIFF_SESSION_PATH = '/liff/session'

/**
 * Marks a session opened from a LIFF ID token. Better Auth makes its own tokens of letters and digits only, so no other
 * session starts with it. A Session.channel column would say the same without a token format; that needs a migration.
 * src/server/db/sql/identity.ts (deleteMemberLiffSessions) matches the same prefix in SQL.
 */
export const LIFF_SESSION_TOKEN_PREFIX = 'liff_'
/** Random bytes after the link's id: 24 bytes are 32 base64url characters, as long as Better Auth's own tokens */
const LIFF_SESSION_TOKEN_BYTES = 24
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** liff_<ChannelIdentity id, as Postgres writes a uuid>.<32 base64url characters>: the only shape a LIFF session has */
const BOUND_LIFF_SESSION_TOKEN = /^liff_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32}$/

/** True for a session opened from a LIFF ID token: LIFF pages only (resolveSession), whether its link still stands or not */
export function isLiffSessionToken(token: string): boolean {
  return token.startsWith(LIFF_SESSION_TOKEN_PREFIX)
}

/**
 * The token of a new LIFF session opened with the LINE link `channelIdentityId` (the sign-in) or of the same session
 * after a step-up (liff-session-rotation.ts): the session stands on that link, and on no other, for its whole life.
 */
export function newLiffSessionToken(channelIdentityId: string): string {
  if (!UUID.test(channelIdentityId)) throw new TypeError('a LIFF session is bound to a ChannelIdentity id (a uuid)')
  return `${LIFF_SESSION_TOKEN_PREFIX}${channelIdentityId}.${randomBytes(LIFF_SESSION_TOKEN_BYTES).toString('base64url')}`
}

/**
 * The ChannelIdentity a LIFF session's token names; null for any other token, and for a LIFF token that names none (a
 * session opened before sessions were bound to their link), which is refused and ended wherever it is seen.
 */
export function liffSessionIdentityId(token: string): string | null {
  return BOUND_LIFF_SESSION_TOKEN.exec(token)?.[1] ?? null
}

/** What a Session row says about its own limits: its token (a LIFF session idles out sooner) and its times */
export interface SessionLimitsRow {
  readonly token: string
  readonly createdAt: Date
  readonly lastActiveAt: Date | null
  readonly expiresAt: Date
}

/**
 * The session is past a limit at `now` by its own times (FR-AUTH-003 AC1, on the security clock): Better Auth's expiry,
 * 12 hours since it was opened, or, since its last activity (its opening when it has none), the idle limit of the pages
 * it may open — a LIFF session's 15 minutes, any other session's 30 (the workspace takes it that long). resolveSession
 * refuses and deletes such a session on its next request; the list of signed-in devices leaves it out, and a LIFF
 * sign-in replaces it whoever's it was. Whether a LIFF session's link stands is asked apart (liffSessionMemberIds).
 */
export function sessionPastItsLimits(s: SessionLimitsRow, now: Date): boolean {
  const at = now.getTime()
  const idleLimit = isLiffSessionToken(s.token) ? SESSION_IDLE_LIFF_MS : SESSION_IDLE_WEB_MS
  const lastActive = (s.lastActiveAt ?? s.createdAt).getTime()
  return s.expiresAt.getTime() <= at || at - s.createdAt.getTime() >= SESSION_ABSOLUTE_MS || at - lastActive >= idleLimit
}

/**
 * The Better Auth endpoints that take a request carrying a LIFF session; every other one refuses it (403, reason
 * LIFF_SESSION), endpoints added by a later Better Auth version included. Allowed: the LIFF sign-in itself (renewal),
 * reading the session (resolveSession), signing out, and the steps of an e-mail sign-in or a password reset, which never
 * read the current session — a LINE browser can still sign in with the password (a new session replaces the cookie) or
 * reset a forgotten one. The two-factor steps are not here: with a session they confirm a TOTP setup and sign in anew.
 * Even here a LIFF session counts only while the link it was opened with stands: otherwise it is ended before the
 * endpoint runs, which then runs as for a browser without a session (endStaleLiffSession).
 */
export const LIFF_SESSION_ALLOWED_PATHS: ReadonlySet<string> = new Set([
  LIFF_SESSION_PATH,
  '/get-session',
  '/sign-out',
  '/sign-in/email',
  '/request-password-reset',
  '/reset-password',
  '/reset-password/:token',
])

/** The LIFF channel whose ID tokens are accepted: the one verifyLiffIdToken asked LINE about */
function liffChannelId(): string | undefined {
  return override?.channelId ?? getEnv().LINE_LIFF_CHANNEL_ID
}

/** Whose links: a verified LINE user's (a sign-in), or a sign-in identity's — only the one link `identityId` when given */
type LiffLinkOwner = { readonly lineUserId: string } | { readonly userId: string; readonly identityId?: string }

/**
 * Live LINE links that a LIFF sign-in or session stands on: unlinkedAt null, made under the provider of the
 * organization's channel (user ids differ per provider, §9.2), of an ACTIVE member with a sign-in identity, in an ACTIVE
 * organization whose LINE channel is switched on for this LIFF channel. Looked up across organizations: a LIFF page does
 * not say which organization it is for.
 */
async function liffLinks(channelId: string, who: LiffLinkOwner) {
  const links = await systemDb.channelIdentity.findMany({
    where: {
      channel: 'LINE',
      unlinkedAt: null,
      ...('lineUserId' in who ? { externalUserId: who.lineUserId } : {}),
      ...('identityId' in who && who.identityId ? { id: who.identityId } : {}),
      member: { status: 'ACTIVE', userId: 'userId' in who ? who.userId : { not: null } },
      organization: { status: 'ACTIVE', lineChannelConfig: { is: { active: true, liffChannelId: channelId } } },
    },
    select: {
      id: true,
      memberId: true,
      providerKey: true,
      member: { select: { userId: true, createdAt: true } },
      organization: { select: { lineChannelConfig: { select: { providerId: true } } } },
    },
  })
  return links.filter((l) => l.providerKey === l.organization.lineChannelConfig?.providerId)
}

export type LiffSignInRefusal = 'LINK_REQUIRED' | 'LINK_AMBIGUOUS'
export type LiffLinkedUser =
  /** `identityId`: the link the new session stands on (see the session policy above) */
  | { readonly ok: true; readonly userId: string; readonly identityId: string }
  | { readonly ok: false; readonly reason: LiffSignInRefusal }

/**
 * The sign-in identity a verified LINE user id stands for, and the link a session of this sign-in stands on (see the
 * session policy above). The LINE user id comes from a token LINE verified, never from the client (BR-LINE-01). One
 * identity may be linked with the same LINE account in more than one organization (FR-LINE-001 AC3: one member per
 * organization): the session stands on the link of the member that identity joined first — the member resolveSession
 * opened before sessions were bound to one link.
 */
export async function findLiffLinkedUser(lineUserId: string, channelId: string): Promise<LiffLinkedUser> {
  const links = (await liffLinks(channelId, { lineUserId })).flatMap((l) => (l.member.userId ? [{ ...l, userId: l.member.userId }] : []))
  const users = new Set(links.map((l) => l.userId))
  if (users.size === 0) return { ok: false, reason: 'LINK_REQUIRED' }
  if (users.size > 1) return { ok: false, reason: 'LINK_AMBIGUOUS' }
  const [first] = links.sort((a, b) => a.member.createdAt.getTime() - b.member.createdAt.getTime() || a.memberId.localeCompare(b.memberId))
  return { ok: true, userId: first!.userId, identityId: first!.id }
}

/**
 * The member a LIFF session of this sign-in identity may act as, checked on every request (resolveSession): the member
 * of the link its token names (liff_<ChannelIdentity id>.…), while that very link stands as a LIFF sign-in requires — at
 * most one. Empty for a token that names no link, a link that ended or is not this identity's, and when LIFF is not set
 * up here: the session is then ended by whoever asked.
 */
export async function liffSessionMemberIds(userId: string, token: string): Promise<ReadonlySet<string>> {
  const channelId = liffChannelId()
  const identityId = liffSessionIdentityId(token)
  if (!channelId || !identityId) return new Set()
  return new Set((await liffLinks(channelId, { userId, identityId })).map((l) => l.memberId))
}

/**
 * The links a LIFF session of this sign-in identity may stand on now (ChannelIdentity ids): what the list of signed-in
 * devices (src/server/auth/sessions.ts) checks a LIFF session's token against. Empty when LIFF is not set up here.
 */
export async function liffSessionLinkIdsOf(userId: string): Promise<ReadonlySet<string>> {
  const channelId = liffChannelId()
  if (!channelId) return new Set()
  return new Set((await liffLinks(channelId, { userId })).map((l) => l.id))
}

/**
 * Ends the LIFF session of `token` unless it still stands (liffSessionMemberIds); true when it stands. A session that is
 * not there any more does not stand. The row is deleted by its id and this very token, so a renewal or a step-up that
 * replaced the token in the meantime is left alone. Nothing here logs the token.
 */
export async function endStaleLiffSession(token: string): Promise<boolean> {
  const session = await systemDb.session.findUnique({ where: { token }, select: { id: true, userId: true } })
  if (!session) return false
  if ((await liffSessionMemberIds(session.userId, token)).size > 0) return true
  await systemDb.session.deleteMany({ where: { id: session.id, token } })
  return false
}

const refuse = (reason: LiffSignInRefusal | 'CROSS_SITE' | 'LIFF_SESSION' | 'SIGNED_IN_AS_ANOTHER_USER') => new APIError('FORBIDDEN', { message: reason, code: 'FORBIDDEN', reason })

/**
 * A sign-in sent by a page of this site (the LIFF app at APP_URL/liff): another site's page must not sign a browser into
 * an account (login CSRF). A browser says where a request comes from (Sec-Fetch-Site, Origin); a request that says
 * nothing is not a browser's and passes. Better Auth's formCsrfMiddleware checks the same in production but stands down
 * in test runs, so this check is ours and runs everywhere.
 */
export function isLiffRequestFromThisSite(headers: Headers | undefined): boolean {
  if (!headers) return true
  const site = headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(getEnv().APP_URL).origin
  } catch {
    return false
  }
}

type LiffSignInFailure = 'TOKEN_INVALID' | LiffSignInRefusal

/** auth.login_failed for a LIFF sign-in: no e-mail is known, so it is the platform's (memberKnown false) */
async function recordLiffFailure(reason: LiffSignInFailure, headers: Headers | undefined, now: Date): Promise<void> {
  await recordAuthEvent('auth.login_failed', '', { ip: ipPrefix(clientIp(headers)), step: 'liff', reason }, now, { channel: 'LIFF' })
}

/**
 * The session the browser holds now may be replaced by a LIFF sign-in of `userId`: there is none, it is that identity's
 * own (a renewal), or it has ended — past its limits (sessionPastItsLimits) or, for a LIFF session, its link no longer
 * standing — so that resolveSession would refuse it anyway. A live session of another sign-in identity is never replaced.
 */
async function replaceableBy(userId: string, token: string, now: Date): Promise<boolean> {
  const current = await systemDb.session.findUnique({ where: { token }, select: { userId: true, token: true, createdAt: true, lastActiveAt: true, expiresAt: true } })
  if (!current || current.userId === userId || sessionPastItsLimits(current, now)) return true
  return isLiffSessionToken(current.token) && (await liffSessionMemberIds(current.userId, current.token)).size === 0
}

export function liffIdToken() {
  return {
    id: 'liff-id-token',
    hooks: {
      before: [
        {
          // Every endpoint, dispatched over HTTP or called as auth.api (resolveSession reads /get-session): deny by
          // default — a LIFF session reaches only LIFF_SESSION_ALLOWED_PATHS (see there) — and there only while the link
          // it was opened with stands; otherwise it is ended here and the endpoint runs as without a session: /get-session
          // answers none, signing out and a renewal find nothing to end, and the sign-in steps never read it
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret)
            if (typeof token !== 'string' || !isLiffSessionToken(token)) return
            if (!LIFF_SESSION_ALLOWED_PATHS.has(ctx.path ?? '')) throw refuse('LIFF_SESSION')
            await endStaleLiffSession(token)
          }),
        },
      ],
    },
    endpoints: {
      liffSession: createAuthEndpoint(
        LIFF_SESSION_PATH,
        {
          method: 'POST',
          // The ID token and nothing else (BR-LINE-01); and only from a page of this site, as Better Auth guards its own
          // sign-in (login CSRF) — on this path and on /api/liff/session, which hands requests here
          body: z.strictObject({ idToken: z.string().min(1).max(LIFF_ID_TOKEN_MAX_LENGTH) }),
          use: [formCsrfMiddleware],
        },
        async (ctx) => {
          if (!isLiffRequestFromThisSite(ctx.headers)) throw refuse('CROSS_SITE')
          const now = systemClock.now()
          const verified = await verifyLiffIdToken(ctx.body.idToken, now)
          if (!verified.ok) {
            if (verified.reason === 'INVALID') {
              await recordLiffFailure('TOKEN_INVALID', ctx.headers, now)
              throw new APIError('UNAUTHORIZED', { message: 'TOKEN_INVALID', code: 'TOKEN_INVALID' })
            }
            throw new APIError('SERVICE_UNAVAILABLE', { message: 'EXTERNAL_SERVICE_ERROR', code: 'EXTERNAL_SERVICE_ERROR' })
          }
          const channelId = liffChannelId()
          const linked = channelId ? await findLiffLinkedUser(verified.lineUserId, channelId) : ({ ok: false, reason: 'LINK_REQUIRED' } as const)
          const user = linked.ok ? await ctx.context.internalAdapter.findUserById(linked.userId) : null
          if (!linked.ok || !user) {
            const reason = linked.ok ? 'LINK_REQUIRED' : linked.reason
            if (reason === 'LINK_AMBIGUOUS') logger.warn({ reason }, 'LIFF sign-in refused: one LINE account is linked to members of different sign-in identities')
            await recordLiffFailure(reason, ctx.headers, now)
            throw refuse(reason)
          }
          // Renewal: the session this browser holds now is replaced, not left behind (holding its cookie is the right to end
          // it) — but only the same identity's: a LINE login never takes the place of someone else's sign-in in this browser
          const current = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret)
          if (typeof current === 'string' && current) {
            if (!(await replaceableBy(user.id, current, now))) {
              logger.warn({ reason: 'SIGNED_IN_AS_ANOTHER_USER' }, 'LIFF sign-in refused: the browser holds a session of another sign-in identity, which stays')
              // A failed sign-in of the LINE account's own member (the identity is known here), with the reason
              await recordAuthEvent(
                'auth.login_failed',
                normalizeEmail(user.email),
                { ip: ipPrefix(clientIp(ctx.headers)), step: 'liff', reason: 'SIGNED_IN_AS_ANOTHER_USER' },
                now,
                { channel: 'LIFF' },
              )
              throw refuse('SIGNED_IN_AS_ANOTHER_USER')
            }
            await ctx.context.internalAdapter.deleteSession(current)
          }
          // The new session stands on the link it was opened with, and on no other (see the session policy above)
          const session = await ctx.context.internalAdapter.createSession(user.id, false, { token: newLiffSessionToken(linked.identityId) }, true)
          await setSessionCookie(ctx, { session, user })
          await recordAuthEvent('auth.login_succeeded', normalizeEmail(user.email), { ip: ipPrefix(clientIp(ctx.headers)), step: 'liff' }, now, { channel: 'LIFF' })
          return ctx.json({ ok: true })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
