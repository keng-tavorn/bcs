import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { LIFF_ID_TOKEN_MAX_LENGTH, MS_PER_SECOND } from '@/lib/constants'
import { getEnv } from '@/lib/env'

// LIFF sign-in (BR-LINE-01, BR-LINE-02): the LIFF page sends liff.getIDToken() to POST /api/auth/liff/session.
// The server asks LINE's verify endpoint with the channel that issued the LIFF app (LINE_LIFF_CHANNEL_ID),
// checks iss, aud and exp itself (Better Auth's LINE provider is not used: MINI App tokens carry a different aud),
// and uses `sub` as the LINE user id. Nothing the client says about the user is trusted.
// The LINE user is mapped to a sign-in identity by the resolver that S5 registers (ChannelIdentity, FR-LINE-001);
// until then every LIFF sign-in is refused as "not linked".

export const LINE_ID_TOKEN_ISSUER = 'https://access.line.me'
const VERIFY_TIMEOUT_MS = 5 * MS_PER_SECOND

export type LiffUserResolver = (lineUserId: string) => Promise<string | null>
let resolveUser: LiffUserResolver = async () => null

export function setLiffUserResolver(resolver: LiffUserResolver | null): void {
  resolveUser = resolver ?? (async () => null)
}

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

export function liffIdToken() {
  return {
    id: 'liff-id-token',
    endpoints: {
      liffSession: createAuthEndpoint(
        '/liff/session',
        { method: 'POST', body: z.object({ idToken: z.string().min(1).max(LIFF_ID_TOKEN_MAX_LENGTH) }) },
        async (ctx) => {
          const verified = await verifyLiffIdToken(ctx.body.idToken, systemClock.now())
          if (!verified.ok) {
            if (verified.reason === 'INVALID') throw new APIError('UNAUTHORIZED', { message: 'TOKEN_INVALID', code: 'TOKEN_INVALID' })
            throw new APIError('SERVICE_UNAVAILABLE', { message: 'EXTERNAL_SERVICE_ERROR', code: 'EXTERNAL_SERVICE_ERROR' })
          }
          const userId = await resolveUser(verified.lineUserId)
          const user = userId ? await ctx.context.internalAdapter.findUserById(userId) : null
          if (!user) throw new APIError('FORBIDDEN', { message: 'LINE_NOT_LINKED', code: 'LINE_NOT_LINKED' })
          const session = await ctx.context.internalAdapter.createSession(user.id)
          await setSessionCookie(ctx, { session, user })
          return ctx.json({ ok: true })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
