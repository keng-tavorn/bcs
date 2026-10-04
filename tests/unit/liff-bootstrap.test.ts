import { describe, expect, it } from 'vitest'
import { MS_PER_MINUTE, SESSION_IDLE_LIFF_MS, SESSION_TOUCH_AFTER_MS } from '@/lib/constants'
import {
  FINAL_SIGN_IN_REFUSALS,
  forgetUnlinked,
  isLineUserAgent,
  knownUnlinked,
  LIFF_RENEW_AFTER_MS,
  LIFF_RENEW_RETRY_MS,
  liffStateTarget,
  rememberUnlinked,
  renewalDue,
  sessionTouchedAt,
  signInRefusalOf,
  webSignInHref,
  type MarkerStorage,
} from '@/ui/liff/bootstrap'
import { linkRefusalKey, retryTimeOf } from '@/ui/liff/link-refusal'

// S5-06 · the rules of the LIFF bootstrap (src/ui/liff/bootstrap.ts): when the session is renewed before the LIFF idle
// limit, what a refused LIFF sign-in means, where a deep link of LINE and a page opened outside LINE go, what a tab
// remembers about an unlinked LINE account, and the words of a refused link. The keeper that runs the renewal is in
// tests/unit/liff-session-keeper.test.ts; the bootstrap itself in tests/e2e/liff-shell.spec.ts and liff-link.spec.ts.

describe('[FR-AUTH-003/AC1] a LIFF session is renewed with a fresh ID token before the 15-minute idle limit', () => {
  it('renews an active person before the limit, and never without a session the page knows of', () => {
    expect(LIFF_RENEW_AFTER_MS).toBeLessThan(SESSION_IDLE_LIFF_MS)
    expect(LIFF_RENEW_AFTER_MS).toBeGreaterThan(SESSION_IDLE_LIFF_MS / 2)
    const signedIn = 1_000_000
    expect(renewalDue(signedIn, signedIn)).toBe(false)
    expect(renewalDue(signedIn, signedIn + LIFF_RENEW_AFTER_MS - 1)).toBe(false)
    expect(renewalDue(signedIn, signedIn + LIFF_RENEW_AFTER_MS)).toBe(true)
    // Long after the idle limit: renewing is the silent sign-in again
    expect(renewalDue(signedIn, signedIn + 2 * SESSION_IDLE_LIFF_MS)).toBe(true)
    expect(renewalDue(null, signedIn + 2 * SESSION_IDLE_LIFF_MS)).toBe(false)
  })

  it('tries at most once a minute, whatever the last attempt answered', () => {
    const signedIn = 1_000_000
    const due = signedIn + LIFF_RENEW_AFTER_MS + MS_PER_MINUTE
    expect(renewalDue(signedIn, due, due - LIFF_RENEW_RETRY_MS + 1)).toBe(false)
    expect(renewalDue(signedIn, due, due - LIFF_RENEW_RETRY_MS)).toBe(true)
    expect(renewalDue(signedIn, due, null)).toBe(true)
  })

  it('counts a page that came with a session from the last time the server may have touched it', () => {
    expect(sessionTouchedAt(5_000_000)).toBe(5_000_000 - SESSION_TOUCH_AFTER_MS)
    // So a page loaded with a session is renewed no later than the margin before the limit
    const loaded = 5_000_000
    expect(renewalDue(sessionTouchedAt(loaded), loaded + SESSION_IDLE_LIFF_MS - SESSION_TOUCH_AFTER_MS - 1)).toBe(true)
  })
})

describe('[BR-LINE-01] a refused LIFF sign-in is read from the answer of POST /api/liff/session, never guessed', () => {
  it('maps every answer of the route to what the page does next', () => {
    expect(signInRefusalOf(403, { code: 'FORBIDDEN', reason: 'LINK_REQUIRED' })).toBe('LINK_REQUIRED')
    expect(signInRefusalOf(403, { code: 'FORBIDDEN', reason: 'LINK_AMBIGUOUS' })).toBe('LINK_AMBIGUOUS')
    expect(signInRefusalOf(403, { code: 'FORBIDDEN', reason: 'CROSS_SITE' })).toBe('FAILED')
    expect(signInRefusalOf(401, { code: 'TOKEN_INVALID' })).toBe('TOKEN_INVALID')
    expect(signInRefusalOf(429, null)).toBe('UNAVAILABLE')
    expect(signInRefusalOf(503, { code: 'EXTERNAL_SERVICE_ERROR' })).toBe('UNAVAILABLE')
    expect(signInRefusalOf(500, 'not json')).toBe('UNAVAILABLE')
    expect(signInRefusalOf(400, { code: 'VALIDATION_FAILED' })).toBe('FAILED')
    expect(signInRefusalOf(413, undefined)).toBe('FAILED')
  })

  it('stops renewing after every refusal but "LINE or BCS could not be reached"', () => {
    expect([...FINAL_SIGN_IN_REFUSALS].sort()).toEqual(['FAILED', 'LINK_AMBIGUOUS', 'LINK_REQUIRED', 'NOT_IN_LINE', 'TOKEN_INVALID'])
  })
})

describe('[§9.4] deep links of LINE and LIFF pages opened outside the LINE app', () => {
  it('follows ?liff.state= only to a page of this site under /liff', () => {
    expect(liffStateTarget('/tasks/0199a5a4-1111-7000-8000-000000000001?action=approve')).toBe('/liff/tasks/0199a5a4-1111-7000-8000-000000000001?action=approve')
    expect(liffStateTarget('/link?code=l1.abc-DEF_09.x')).toBe('/liff/link?code=l1.abc-DEF_09.x')
    expect(liffStateTarget('/help')).toBe('/liff/help')
    for (const away of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'tasks', '', '/a b', '/<script>']) expect(liffStateTarget(away), away).toBeNull()
    expect(liffStateTarget(null)).toBeNull()
    expect(liffStateTarget(undefined)).toBeNull()
  })

  it('refuses dot segments, plain or percent-encoded, which would leave the LIFF app', () => {
    for (const away of ['/../settings/line', '/%2e%2e/admin', '/%2E%2E/admin', '/.%2e/admin', '/%2e./admin', '/tasks/../../admin', '/./help', '/..', '/%2e%2e']) {
      expect(liffStateTarget(away), away).toBeNull()
    }
    // Dots inside a name are no segment of their own; a query is not a path
    expect(liffStateTarget('/help.v2')).toBe('/liff/help.v2')
    expect(liffStateTarget('/link?code=l1.a..b')).toBe('/liff/link?code=l1.a..b')
  })

  it('sends a page opened outside LINE to the web sign-in, which comes back to the same LIFF page', () => {
    expect(webSignInHref('/liff/help')).toBe('/login?next=%2Fliff%2Fhelp')
    expect(webSignInHref('/liff/tasks/abc?action=approve')).toBe('/login?next=%2Fliff%2Ftasks%2Fabc%3Faction%3Dapprove')
    expect(webSignInHref('//evil.example')).toBe('/login')
    expect(webSignInHref('https://evil.example/liff')).toBe('/login')
  })

  it('tells the LINE app from another browser only to word a failed start of the SDK', () => {
    expect(isLineUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0')).toBe(true)
    expect(isLineUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 Line/14.10.1/IAB')).toBe(true)
    expect(isLineUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36')).toBe(false)
  })
})

/** sessionStorage as a Map; `broken` throws like a browser that refuses storage */
function storage(broken = false): MarkerStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  const fail = () => {
    throw new Error('SecurityError')
  }
  return {
    map,
    getItem: (k) => (broken ? fail() : (map.get(k) ?? null)),
    setItem: (k, v) => (broken ? fail() : void map.set(k, v)),
    removeItem: (k) => (broken ? fail() : void map.delete(k)),
  }
}

describe('[BR-LINE-01] the help page asks LINE once per tab about a LINE account that is not linked', () => {
  it('remembers the refusal for that LINE user only, holds nothing of the token, and forgets it after a link', () => {
    const tab = storage()
    expect(knownUnlinked(tab, 'Uaaa')).toBe(false)
    rememberUnlinked(tab, 'Uaaa')
    expect(knownUnlinked(tab, 'Uaaa')).toBe(true)
    // Another mocked LINE user in the same tab is asked again
    expect(knownUnlinked(tab, 'Ubbb')).toBe(false)
    expect([...tab.map.values()]).toEqual(['1'])
    forgetUnlinked(tab, 'Uaaa')
    expect(knownUnlinked(tab, 'Uaaa')).toBe(false)
  })

  it('asks every time when the browser refuses storage, and never throws', () => {
    const refusing = storage(true)
    expect(() => rememberUnlinked(refusing, 'line')).not.toThrow()
    expect(knownUnlinked(refusing, 'line')).toBe(false)
    expect(() => forgetUnlinked(refusing, 'line')).not.toThrow()
    expect(knownUnlinked(null, 'line')).toBe(false)
  })
})

describe('[FR-LINE-001/AC1] a refused link is said in words: expired, used, someone else’s, rate limited', () => {
  it('turns every answer of the link service into its message key', () => {
    expect(linkRefusalKey({ code: 'TOKEN_EXPIRED' })).toBe('TOKEN_EXPIRED')
    expect(linkRefusalKey({ code: 'TOKEN_EXPIRED', reason: 'UNLINKED_SINCE' })).toBe('UNLINKED_SINCE')
    expect(linkRefusalKey({ code: 'TOKEN_USED' })).toBe('TOKEN_USED')
    expect(linkRefusalKey({ code: 'IDEMPOTENCY_CONFLICT' })).toBe('TOKEN_USED')
    expect(linkRefusalKey({ code: 'TOKEN_INVALID' })).toBe('TOKEN_INVALID')
    expect(linkRefusalKey({ code: 'VALIDATION_FAILED', field: 'code' })).toBe('TOKEN_INVALID')
    expect(linkRefusalKey({ code: 'VALIDATION_FAILED', field: 'idToken' })).toBe('ID_TOKEN_INVALID')
    expect(linkRefusalKey({ code: 'VALIDATION_FAILED', field: '(body)' })).toBe('FAILED')
    for (const reason of ['LINE_NOT_ENABLED', 'ALREADY_LINKED', 'ACCOUNT_LINKED_TO_ANOTHER_MEMBER', 'MEMBER_LINKED_TO_ANOTHER_ACCOUNT', 'NOT_LINKED', 'LINK_CHANGED']) {
      expect(linkRefusalKey({ code: 'INVALID_STATE_TRANSITION', reason })).toBe(reason)
    }
    expect(linkRefusalKey({ code: 'INVALID_STATE_TRANSITION', reason: 'SOMETHING_NEW' })).toBe('FAILED')
    expect(linkRefusalKey({ code: 'FORBIDDEN' })).toBe('FORBIDDEN')
    expect(linkRefusalKey({ code: 'FORBIDDEN', reason: 'CROSS_SITE' })).toBe('FAILED')
    expect(linkRefusalKey({ code: 'FORBIDDEN', reason: 'PASSWORD_SIGN_IN_REQUIRED' })).toBe('SIGN_IN_WITH_PASSWORD')
    expect(linkRefusalKey({ code: 'RATE_LIMITED', reason: 'LINK_ATTEMPTS', time: '2026-10-04T10:00:00.000Z' })).toBe('RATE_LIMITED')
    expect(linkRefusalKey({ code: 'RATE_LIMITED', reason: 'LINE_CHECKS' })).toBe('RATE_LIMITED_LATER')
    expect(linkRefusalKey({ code: 'RATE_LIMITED', time: 'soon' })).toBe('RATE_LIMITED_LATER')
    expect(linkRefusalKey({ code: 'UNAUTHENTICATED', reason: 'ID_TOKEN_INVALID' })).toBe('ID_TOKEN_INVALID')
    expect(linkRefusalKey({ code: 'UNAUTHENTICATED' })).toBe('UNAUTHENTICATED')
    expect(linkRefusalKey({ code: 'EXTERNAL_SERVICE_ERROR' })).toBe('EXTERNAL_SERVICE_ERROR')
    expect(linkRefusalKey({ code: 'INTERNAL' })).toBe('FAILED')
  })

  it('reads when to try again only from a real time', () => {
    expect(retryTimeOf({ code: 'RATE_LIMITED', time: '2026-10-04T10:00:00.000Z' })?.toISOString()).toBe('2026-10-04T10:00:00.000Z')
    expect(retryTimeOf({ code: 'RATE_LIMITED', time: 'later' })).toBeNull()
    expect(retryTimeOf({ code: 'RATE_LIMITED' })).toBeNull()
  })
})
