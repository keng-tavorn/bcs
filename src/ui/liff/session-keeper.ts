import {
  FINAL_SIGN_IN_REFUSALS,
  LIFF_MOCK_TOKEN_ENDPOINT,
  LIFF_SESSION_ENDPOINT,
  renewalDue,
  sessionTouchedAt,
  signInRefusalOf,
  type LiffSignInRefusal,
  type LiffSignInResult,
} from './bootstrap'

// The LIFF sign-in and its silent renewal (§9.4, ADR-046, FR-AUTH-003 AC1, NFR-SEC-04), apart from React so a unit test
// runs it with a fake fetch and a fake clock (tests/unit/liff-session-keeper.test.ts); ./liff-provider.tsx holds one
// per page load. What it does:
//  - signIn(): the gate of a page rendered without a session asks for it. A fresh ID token goes to POST
//    /api/liff/session, which opens a LIFF session (the server replaces whatever session the browser held). Calls made
//    while one is on its way share it.
//  - renewIfDue(): a tap, a key, the page coming back into view, or a page about to run a server action asks for it.
//    It renews only a session opened with LINE — the page said so (seen('liff')) or this keeper opened it — so a
//    password sign-in made inside LINE is never swapped for the session of whoever this LINE account is linked to. It
//    renews when the last sign-in or page load is LIFF_RENEW_AFTER_MS old, tries at most once a minute
//    (LIFF_RENEW_RETRY_MS: every attempt counts, answered or not), and after an answer that the same page load cannot
//    change (not linked any more, linked twice, a token LINE no longer accepts, no token at all) it stops for the page
//    load: the session then idles out and the gate of the next page signs in again. Only "LINE or BCS could not be
//    reached" is tried again, once a minute at most.
//  - It answers what it found (LiffSessionCheck), so a page about to run a server action knows when the LIFF session
//    cannot be kept on this page load — and loads the page again for a new ID token, or shows the gate — instead of
//    sending the action with a session that has ended and losing what the person typed.
// The ID token lives in memory for one request: never in a URL, storage or a log.

export type LiffSessionKind = 'liff' | 'web'

/** What renewIfDue() found (useLiff().ensureSession() before a server action) */
export type LiffSessionCheck =
  /** Nothing in the way: a LIFF session renewed or not near its limit yet, a password session, or no session to keep */
  | { readonly ok: true }
  /**
   * The LIFF session could not be renewed. `final`: not on this page load at all (FINAL_SIGN_IN_REFUSALS) — in the LINE
   * app a new page load brings a new ID token (TOKEN_INVALID), otherwise the gate says what to do. Not final: LINE or
   * BCS could not be reached just now, and the session may still have a few minutes.
   */
  | { readonly ok: false; readonly reason: LiffSignInRefusal; readonly final: boolean }

export interface LiffSessionKeeperDeps {
  /** Browser time in ms (Date.now) */
  readonly now: () => number
  /** A fresh ID token: null outside LINE; throws when it could not be had */
  readonly idToken: () => Promise<string | null>
  /** window.fetch (a test passes its own) */
  readonly fetch: typeof fetch
}

export interface LiffSessionKeeper {
  /** The server rendered the page with this session, or none (the layout says it on every render of the page) */
  seen(kind: LiffSessionKind | null): void
  /** Opens a LIFF session with the LINE ID token now (the gate); parallel calls share one request */
  signIn(): Promise<LiffSignInResult>
  /** Renews a LIFF session close to its idle limit, under the rules above, and says what it found; never throws */
  renewIfDue(): Promise<LiffSessionCheck>
}

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store', credentials: 'same-origin' } as const

const KEPT: LiffSessionCheck = { ok: true }

/** A sign-in's answer as a check: a refusal is final when the same page load cannot turn it around */
function checkOf(result: LiffSignInResult): LiffSessionCheck {
  return result.ok ? KEPT : { ok: false, reason: result.reason, final: FINAL_SIGN_IN_REFUSALS.has(result.reason) }
}

/** LIFF_MOCK (local only): an ID token of the fake LINE server for this LINE user (POST /api/liff/mock-token) */
export async function mockIdToken(fetchImpl: typeof fetch, lineUserId: string): Promise<string | null> {
  const response = await fetchImpl(LIFF_MOCK_TOKEN_ENDPOINT, { ...JSON_POST, body: JSON.stringify({ lineUserId }) })
  const body = (await response.json().catch(() => null)) as { idToken?: unknown } | null
  if (!response.ok) throw new Error(`the mock ID token was refused (${response.status})`)
  return typeof body?.idToken === 'string' ? body.idToken : null
}

export function createLiffSessionKeeper(deps: LiffSessionKeeperDeps): LiffSessionKeeper {
  /** The kind of session the browser holds, as far as the page knows */
  let session: LiffSessionKind | null = null
  /** When the LIFF session was last opened or seen (browser time) */
  let lastContact: number | null = null
  /** When a sign-in or renewal was last sent, whatever came back */
  let lastAttempt: number | null = null
  /** The answer this page load cannot change, once one came back: no more renewals until a sign-in succeeds */
  let stoppedBy: LiffSignInRefusal | null = null
  let pending: Promise<LiffSignInResult> | null = null

  async function attempt(): Promise<LiffSignInResult> {
    lastAttempt = deps.now()
    let token: string | null
    try {
      token = await deps.idToken()
    } catch {
      return { ok: false, reason: 'UNAVAILABLE' }
    }
    if (!token) return { ok: false, reason: 'NOT_IN_LINE' }
    let response: Response
    try {
      response = await deps.fetch(LIFF_SESSION_ENDPOINT, { ...JSON_POST, body: JSON.stringify({ idToken: token }) })
    } catch {
      return { ok: false, reason: 'UNAVAILABLE' }
    }
    // The answer is read to its end whatever it says: a body nobody reads keeps the request open in the browser
    const body: unknown = await response.json().catch(() => null)
    if (response.ok) return { ok: true }
    return { ok: false, reason: signInRefusalOf(response.status, body) }
  }

  function signIn(): Promise<LiffSignInResult> {
    pending ??= attempt()
      .then((result) => {
        if (result.ok) {
          session = 'liff'
          lastContact = deps.now()
          stoppedBy = null
        } else if (FINAL_SIGN_IN_REFUSALS.has(result.reason)) {
          stoppedBy = result.reason
        }
        return result
      })
      .finally(() => {
        pending = null
      })
    return pending
  }

  return {
    seen(kind) {
      if (kind === 'liff') {
        // The server touched the session at most SESSION_TOUCH_AFTER_MS ago; a later sign-in of this keeper counts first
        const touched = sessionTouchedAt(deps.now())
        if (session !== 'liff' || lastContact === null || touched > lastContact) lastContact = touched
      }
      session = kind
    },
    signIn,
    async renewIfDue() {
      if (pending) return checkOf(await pending)
      // A password session is never renewed with LINE, and without a session there is nothing to keep
      if (session !== 'liff') return KEPT
      if (stoppedBy) return { ok: false, reason: stoppedBy, final: true }
      if (!renewalDue(lastContact, deps.now(), lastAttempt)) return KEPT
      return checkOf(await signIn())
    },
  }
}
