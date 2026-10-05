import { describe, expect, it } from 'vitest'
import { MS_PER_MINUTE } from '@/lib/constants'
import { LIFF_RENEW_AFTER_MS, LIFF_SESSION_ENDPOINT, signInRefusalOf, signOutBrowser, WEB_SIGN_OUT_ENDPOINT } from '@/ui/liff/bootstrap'
import { createLiffSessionKeeper } from '@/ui/liff/session-keeper'

// S5-06 · a LINE sign-in never takes the place of someone else's live sign-in in this browser: POST /api/liff/session
// refuses it (403 SIGNED_IN_AS_ANOTHER_USER, src/server/auth/liff.ts) and that session stays. The LIFF client reads the
// refusal from the answer (src/ui/liff/bootstrap.ts), takes it as final for the page load (src/ui/liff/session-keeper.ts),
// and its gate offers to sign the browser out (signOutBrowser) and load the page again. The gate's words and the real
// sign-out run in tests/e2e/liff-another-user.spec.ts.

const ANOTHER_USER = { ok: false, code: 'FORBIDDEN', message: 'SIGNED_IN_AS_ANOTHER_USER', reason: 'SIGNED_IN_AS_ANOTHER_USER' }

/** A keeper on a clock the test moves, whose sign-ins are all refused SIGNED_IN_AS_ANOTHER_USER */
function refusedKeeper() {
  let now = 1_800_000_000_000
  const sent: string[] = []
  const keeper = createLiffSessionKeeper({
    now: () => now,
    idToken: async () => 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVbGluZSJ9.c2lnbmVk',
    fetch: (async (input: RequestInfo | URL) => {
      sent.push(String(input))
      return Response.json(ANOTHER_USER, { status: 403 })
    }) as typeof fetch,
  })
  return {
    keeper,
    sent,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('[FR-AUTH-003/AC1] [BR-LINE-01] the LIFF page learns that this browser holds someone else’s sign-in', () => {
  it('reads it from a 403 of POST /api/liff/session only: the same reason under another status is no such answer', () => {
    expect(signInRefusalOf(403, ANOTHER_USER)).toBe('SIGNED_IN_AS_ANOTHER_USER')
    expect(signInRefusalOf(400, ANOTHER_USER)).toBe('FAILED')
    expect(signInRefusalOf(401, ANOTHER_USER)).toBe('TOKEN_INVALID')
    expect(signInRefusalOf(503, ANOTHER_USER)).toBe('UNAVAILABLE')
    expect(signInRefusalOf(403, { reason: 'signed_in_as_another_user' })).toBe('FAILED')
  })

  it('the gate’s sign-in answers it, and asking again on the same page load sends nothing more', async () => {
    const k = refusedKeeper()
    k.keeper.seen(null)
    expect(await k.keeper.signIn()).toEqual({ ok: false, reason: 'SIGNED_IN_AS_ANOTHER_USER' })
    expect(k.sent).toEqual([LIFF_SESSION_ENDPOINT])
  })

  it('a renewal that meets it is final: the page sends no action with a session that cannot be kept, and LINE is not asked again', async () => {
    // A LINE session of this page, while someone signed in with a password in another tab of the same LINE browser
    const k = refusedKeeper()
    k.keeper.seen('liff')
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    expect(await k.keeper.renewIfDue()).toEqual({ ok: false, reason: 'SIGNED_IN_AS_ANOTHER_USER', final: true })
    k.advance(5 * MS_PER_MINUTE)
    expect(await k.keeper.renewIfDue()).toEqual({ ok: false, reason: 'SIGNED_IN_AS_ANOTHER_USER', final: true })
    expect(k.sent).toEqual([LIFF_SESSION_ENDPOINT])
  })
})

describe('[FR-AUTH-003/AC1] the gate signs this browser out before LINE may sign in', () => {
  it('posts to Better Auth’s sign-out from this page with its cookies, and nothing of the ID token', async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
    await signOutBrowser((async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return Response.json({ success: true })
    }) as typeof fetch)
    expect(WEB_SIGN_OUT_ENDPOINT).toBe('/api/auth/sign-out')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(WEB_SIGN_OUT_ENDPOINT)
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', body: '{}' })
  })

  it('never throws, answered or not: the page loads again either way and its gate says what it finds', async () => {
    await expect(signOutBrowser((async () => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch)).resolves.toBeUndefined()
    await expect(signOutBrowser((async () => new Response('refused', { status: 403 })) as typeof fetch)).resolves.toBeUndefined()
    await expect(signOutBrowser((async () => new Response(null, { status: 200 })) as typeof fetch)).resolves.toBeUndefined()
  })
})
