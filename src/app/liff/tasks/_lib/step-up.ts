import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies'
import { cookies } from 'next/headers'
import { systemClock } from '@/lib/clock'
import { rotateLiffSessionAfterStepUp } from '@/server/auth/liff-session-rotation'
import { rotateSessionAfterStepUp, type SignedInSession } from '@/server/auth/session-rotation'
import type { StepUpSession } from '../../../(workspace)/_tracking/commands'
import type { LiffSessionKind } from '../../_lib/session'
import { currentHeaders } from './signed-in'

// The step-up of a decision made on a LIFF page (FR-AUTH-005 AC2, FR-LINE-003 AC2, NFR-SEC-04), for the deciding commands
// of the web decision page (src/app/(workspace)/_tracking/commands.ts): the PIN is checked on the security clock (real
// time), and once it was right the session this request stands on gets a new id before the decision runs — a session
// opened with the LINE ID token through src/server/auth/liff-session-rotation.ts (a new LIFF token on the same sign-in),
// a password session through src/server/auth/session-rotation.ts, as on the web. Which one it is comes from the server's
// session (liffPage), never from the browser. The session is the one the action resolved at its start (./signed-in.ts
// liffSignedIn) — an action that resolved none sends nothing on, so no PIN is checked for it — and it is never looked up
// again after the PIN: when another tab of the same sign-in changed the token meanwhile, the rotation hands this request
// the token now in force (the two step-ups both proved the PIN), so a right PIN always decides while the session lives.
// The new cookie goes into this server action's response — written here from the rotation's Set-Cookie lines, for both
// kinds (for a password session Better Auth's nextCookies() writes the same cookie when its hook runs; written twice it
// is the same cookie) — so the page the action renders again reads it (liffPage reads cookies as Next.js holds them now,
// src/app/_lib/held-cookies.ts).

/** What the rotation reads and writes of the request: its cookies now, and the Set-Cookie lines of its response */
export interface LiffStepUpIo {
  readonly headers: () => Promise<Headers>
  readonly hold: (setCookie: readonly string[]) => Promise<void>
}

/**
 * The Set-Cookie lines of a rotation, written into this server action's response as Better Auth's nextCookies() plugin
 * writes them for an endpoint it dispatched: the LIFF rotation is called directly, outside its hooks; the web rotation's
 * cookie, which the plugin wrote already, is written again with the same value and options
 */
async function holdSetCookies(lines: readonly string[]): Promise<void> {
  const jar = await cookies()
  for (const line of lines) for (const [name, value] of parseSetCookieHeader(line)) jar.set(name, value.value, toCookieOptions(value))
}

const NEXT_IO: LiffStepUpIo = { headers: currentHeaders, hold: holdSetCookies }

/**
 * What a decision with the PIN takes from a LIFF page's server action: real time, and the new session id after the PIN
 * for `signedIn`, the session the action resolved at its start (a session that ended since: no new id, so the command
 * answers UNAUTHENTICATED and decides nothing). `io` is Next.js's request; tests give their own.
 */
export function liffStepUpSession(kind: LiffSessionKind, signedIn: SignedInSession, io: LiffStepUpIo = NEXT_IO): StepUpSession {
  const session: SignedInSession = { sessionId: signedIn.sessionId, userId: signedIn.userId }
  return {
    securityNow: systemClock.now(),
    rotateSession: async () => {
      const requestHeaders = await io.headers()
      const rotated = kind === 'web' ? await rotateSessionAfterStepUp(requestHeaders, session) : await rotateLiffSessionAfterStepUp(requestHeaders, session)
      if (!rotated.ok) return false
      await io.hold(rotated.setCookie)
      return true
    },
  }
}
