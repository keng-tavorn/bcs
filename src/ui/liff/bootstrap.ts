import { MS_PER_MINUTE, SESSION_IDLE_LIFF_MS, SESSION_TOUCH_AFTER_MS } from '@/lib/constants'
import { safeNextPath } from '@/lib/next-path'

// The rules of the LIFF bootstrap (§9.4, ADR-024, ADR-046), kept apart from React so they are tested on their own
// (tests/unit/liff-bootstrap.test.ts, tests/unit/liff-session-keeper.test.ts). The provider (./liff-provider.tsx), the
// session keeper (./session-keeper.ts) and the gate (./liff-gate.tsx) run them.
//  - Who the person is comes from a LINE ID token only (BR-LINE-01): liff.getIDToken() in the LINE app, or with
//    LIFF_MOCK (local) a token the fake LINE server issued through POST /api/liff/mock-token. The token goes to
//    POST /api/liff/session in a request body, never in a URL, and is never written anywhere.
//  - A LIFF session goes idle after 15 minutes (FR-AUTH-003 AC1). The bootstrap renews a LIFF session with a fresh ID
//    token when the person is active again and the last sign-in or page load is older than LIFF_RENEW_AFTER_MS, so an
//    active person never meets the limit and an unattended page does not keep its session alive. It renews only a
//    session opened with LINE (a password sign-in is never swapped for the LINE account's own), tries at most once a
//    minute, and stops for the page load after an answer that will not change (./session-keeper.ts). A page whose
//    session ended anyway shows the gate, which signs in again without asking anything.
//  - A LINE sign-in never takes the place of someone else's live sign-in in this browser (a password or LINE sign-in of
//    another person in this LINE app): the server refuses it (SIGNED_IN_AS_ANOTHER_USER) and that session stays. The
//    gate says so and offers to sign it out (WEB_SIGN_OUT_ENDPOINT); the page then loads again and signs in with LINE.

export const LIFF_BASE_PATH = '/liff'
/** The member's tasks (§9.4 /liff/tasks): where the links back to "งานรออนุมัติ" lead */
export const LIFF_HOME_PATH = '/liff/tasks'
/** Where a linked member lands (§9.4, FR-LINE-302 AC4, ADR-167): /liff sends a linked member to the home page in LINE */
export const LIFF_START_PATH = '/liff/home'
export const LIFF_LINK_PATH = '/liff/link'
export const LIFF_HELP_PATH = '/liff/help'
export const LIFF_SESSION_ENDPOINT = '/api/liff/session'
export const LIFF_LINK_ENDPOINT = '/api/liff/link'
export const LIFF_MOCK_TOKEN_ENDPOINT = '/api/liff/mock-token'
/** Better Auth's sign-out: ends the session this browser holds, whoever's it is, and clears its cookie */
export const WEB_SIGN_OUT_ENDPOINT = '/api/auth/sign-out'
/** The web sign-in a LIFF page opened outside the LINE app sends people to (§9.4) */
export const WEB_SIGN_IN_PATH = '/login'
/** Where a member manages their LINE link and gets a new link code on the web (§9.1 /settings/*, §9.2 step 1) */
export const WEB_LINE_SETTINGS_PATH = '/settings/line'

/** How long before the LIFF idle limit the bootstrap renews the session of an active person */
const RENEW_MARGIN_MS = 3 * MS_PER_MINUTE
export const LIFF_RENEW_AFTER_MS = SESSION_IDLE_LIFF_MS - RENEW_MARGIN_MS
/** A renewal that LINE or BCS could not answer is tried again at most this often */
export const LIFF_RENEW_RETRY_MS = MS_PER_MINUTE

/** Why a LIFF sign-in did not open a session */
export type LiffSignInRefusal =
  /** No ID token: a browser outside the LINE app (or LIFF is not set up here) — use the web sign-in */
  | 'NOT_IN_LINE'
  /** The LINE account is not linked to an active member where LINE is on (403 LINK_REQUIRED): /liff/link */
  | 'LINK_REQUIRED'
  /** One LINE account linked to members of two sign-in identities (403 LINK_AMBIGUOUS): an administrator unlinks one */
  | 'LINK_AMBIGUOUS'
  /**
   * The browser holds a live session of another sign-in identity — someone else signed in in this LINE browser, with a
   * password or through LINE (403 SIGNED_IN_AS_ANOTHER_USER). It stays until it is signed out: the gate offers that
   */
  | 'SIGNED_IN_AS_ANOTHER_USER'
  /** LINE did not accept the token (401), e.g. it expired while the page was open */
  | 'TOKEN_INVALID'
  /** LINE or BCS could not be reached (network, 5xx, 429) */
  | 'UNAVAILABLE'
  | 'FAILED'

export type LiffSignInResult = { readonly ok: true } | { readonly ok: false; readonly reason: LiffSignInRefusal }

/** Refusals that the same page load cannot turn around by asking again: the keeper stops renewing after them */
export const FINAL_SIGN_IN_REFUSALS: ReadonlySet<LiffSignInRefusal> = new Set(['NOT_IN_LINE', 'LINK_REQUIRED', 'LINK_AMBIGUOUS', 'SIGNED_IN_AS_ANOTHER_USER', 'TOKEN_INVALID', 'FAILED'])

const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_TOO_MANY = 429
const HTTP_SERVER_ERROR = 500

/** The refusal of POST /api/liff/session from its status and body (see src/app/api/liff/session/route.ts) */
export function signInRefusalOf(status: number, body: unknown): LiffSignInRefusal {
  const reason = typeof body === 'object' && body !== null && 'reason' in body ? (body as { reason?: unknown }).reason : undefined
  if (status === HTTP_FORBIDDEN && reason === 'LINK_REQUIRED') return 'LINK_REQUIRED'
  if (status === HTTP_FORBIDDEN && reason === 'LINK_AMBIGUOUS') return 'LINK_AMBIGUOUS'
  if (status === HTTP_FORBIDDEN && reason === 'SIGNED_IN_AS_ANOTHER_USER') return 'SIGNED_IN_AS_ANOTHER_USER'
  if (status === HTTP_UNAUTHORIZED) return 'TOKEN_INVALID'
  if (status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR) return 'UNAVAILABLE'
  return 'FAILED'
}

/**
 * Signs this browser out of BCS, so that a LINE sign-in may follow (SIGNED_IN_AS_ANOTHER_USER): Better Auth's sign-out
 * ends the session the browser holds — someone else's — and clears its cookie. The request goes from this page with its
 * cookies, never with anything of the ID token. Never throws: the caller loads the page again whatever came back, and
 * the gate of that page says what it finds then.
 */
export async function signOutBrowser(fetchImpl: typeof fetch): Promise<void> {
  try {
    const response = await fetchImpl(WEB_SIGN_OUT_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', cache: 'no-store', credentials: 'same-origin' })
    // Read to its end: a body nobody reads keeps the request open in the browser
    await response.json().catch(() => null)
  } catch {
    // No answer (the network): the page loads again and the gate tells what it finds
  }
}

/**
 * When the session the page was rendered with was last touched, seen from the browser: the server records activity at
 * most every SESSION_TOUCH_AFTER_MS, so the page counts from that much earlier.
 */
export function sessionTouchedAt(pageLoadedAtMs: number): number {
  return pageLoadedAtMs - SESSION_TOUCH_AFTER_MS
}

/**
 * The session should be renewed now: one is known (lastContactMs), it is older than LIFF_RENEW_AFTER_MS, and the last
 * attempt (whatever its answer) is at least LIFF_RENEW_RETRY_MS old.
 */
export function renewalDue(lastContactMs: number | null, nowMs: number, lastAttemptMs: number | null = null): boolean {
  if (lastContactMs === null || nowMs - lastContactMs < LIFF_RENEW_AFTER_MS) return false
  return lastAttemptMs === null || nowMs - lastAttemptMs >= LIFF_RENEW_RETRY_MS
}

/** The pathname of a site path, without its query (the paths here never carry a fragment: safeNextPath refuses #) */
const pathnameOf = (path: string): string => path.split('?', 1)[0]!

/**
 * The LIFF page a deep link from LINE asks for. https://liff.line.me/<LIFF ID>/<path> opens the app's endpoint (/liff) with
 * ?liff.state=<path>; liff.init() goes on to /liff/<path>, and the bootstrap does the same when it still stands on /liff
 * (and with LIFF_MOCK, where the SDK is not loaded). Only a page of this site under /liff is followed: a path with dot
 * segments, plain or percent-encoded ("/../settings", "/%2e%2e/admin"), would leave the LIFF app and is refused, as the
 * browser would resolve it before the request.
 */
export function liffStateTarget(state: string | null | undefined): string | null {
  if (typeof state !== 'string' || !state.startsWith('/') || state.startsWith('//')) return null
  const target = safeNextPath(`${LIFF_BASE_PATH}${state}`)
  if (!target) return null
  const path = pathnameOf(target)
  let resolved: string
  try {
    resolved = new URL(path, 'https://liff.invalid').pathname
  } catch {
    return null
  }
  // The browser's own resolution must leave the path as it is: no dot segment went away, and it stays under /liff/
  if (resolved !== path || !resolved.startsWith(`${LIFF_BASE_PATH}/`)) return null
  return target
}

/** The web sign-in that returns to this LIFF page afterwards (a path of this site only, safeNextPath) */
export function webSignInHref(returnTo: string): string {
  const next = safeNextPath(returnTo)
  return next ? `${WEB_SIGN_IN_PATH}?next=${encodeURIComponent(next)}` : WEB_SIGN_IN_PATH
}

/** A browser that says it is the LINE app (used only when the LIFF SDK could not start, to word the problem) */
export function isLineUserAgent(userAgent: string): boolean {
  return / Line\/\d/i.test(userAgent)
}

// ---------- a LINE account this tab knows is not linked ----------

/** The part of sessionStorage the marker below needs (a test passes a Map-backed one) */
export interface MarkerStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const UNLINKED_MARKER = 'bcs-liff-unlinked'

/**
 * /liff/help signs in quietly with LINE on load (it shows more to a member). A LINE account that is not linked is
 * refused (LINK_REQUIRED), and every refusal costs a call to LINE and an auth.login_failed Event; so once refused, the
 * tab remembers it for the LINE user (`who`: the mocked LINE user, or "line" in the LINE app, where a LIFF window is one
 * LINE account) and help stops asking until the tab links or signs in. Never the ID token or anything from it.
 */
export function rememberUnlinked(storage: MarkerStorage | null, who: string): void {
  try {
    storage?.setItem(`${UNLINKED_MARKER}:${who}`, '1')
  } catch {
    // Storage refused (private mode): help simply asks again next time
  }
}

export function knownUnlinked(storage: MarkerStorage | null, who: string): boolean {
  try {
    return storage?.getItem(`${UNLINKED_MARKER}:${who}`) === '1'
  } catch {
    return false
  }
}

export function forgetUnlinked(storage: MarkerStorage | null, who: string): void {
  try {
    storage?.removeItem(`${UNLINKED_MARKER}:${who}`)
  } catch {
    // Nothing to forget
  }
}
