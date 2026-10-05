import { describe, expect, it } from 'vitest'
import { MS_PER_MINUTE, MS_PER_SECOND, SESSION_IDLE_LIFF_MS } from '@/lib/constants'
import { LIFF_MOCK_TOKEN_ENDPOINT, LIFF_RENEW_AFTER_MS, LIFF_RENEW_RETRY_MS, LIFF_SESSION_ENDPOINT } from '@/ui/liff/bootstrap'
import { createLiffSessionKeeper, mockIdToken } from '@/ui/liff/session-keeper'

// S5-06 · the LIFF sign-in and its silent renewal (src/ui/liff/session-keeper.ts, which src/ui/liff/liff-provider.tsx
// runs once per page load: the provider's taps, keys and "page shown again" call renewIfDue(), its gate calls signIn()).
// Run here with a fake fetch and a fake clock: what goes to POST /api/liff/session, and how often. The real requests
// run in tests/e2e/liff-shell.spec.ts.

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVbGluZSJ9.c2lnbmVk'

interface Sent {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A keeper on a clock the test moves, whose fetch answers with `answer` and records what was sent */
function keeperWith(answer: (n: number) => Response | Error, options: { token?: string | null | Error } = {}) {
  let now = 1_800_000_000_000
  const sent: Sent[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init })
    const a = answer(sent.length)
    if (a instanceof Error) throw a
    return a
  }) as typeof fetch
  const token = options.token === undefined ? TOKEN : options.token
  const keeper = createLiffSessionKeeper({
    now: () => now,
    idToken: async () => {
      if (token instanceof Error) throw token
      return token
    },
    fetch: fetchImpl,
  })
  return {
    keeper,
    sent,
    advance: (ms: number) => {
      now += ms
    },
    /** A person tapping `times` times, a few seconds apart */
    taps: async (times: number) => {
      for (let i = 0; i < times; i++) {
        await keeper.renewIfDue()
        now += 3 * MS_PER_SECOND
      }
    },
  }
}

const ok = () => Response.json({ ok: true })
const refused = (status: number, body: unknown) => () => Response.json(body, { status })

describe('[FR-AUTH-003/AC1] a LIFF session is renewed with a fresh ID token before the 15-minute idle limit', () => {
  it('renews a LINE session of an active person once it is near the limit, then not again until it is near it again', async () => {
    const k = keeperWith(ok)
    k.keeper.seen('liff')
    // The page counts from when the server may have last touched the session (a minute before the page load)
    k.advance(LIFF_RENEW_AFTER_MS - MS_PER_MINUTE - 1)
    await k.taps(1)
    expect(k.sent).toHaveLength(0)
    k.advance(MS_PER_MINUTE)
    await k.taps(1)
    expect(k.sent).toHaveLength(1)
    // Renewed well inside the server's idle limit
    expect(LIFF_RENEW_AFTER_MS).toBeLessThan(SESSION_IDLE_LIFF_MS)
    // The new session counts from now: more taps do nothing until it is near the limit again
    await k.taps(10)
    k.advance(LIFF_RENEW_AFTER_MS - 40 * MS_PER_SECOND)
    await k.taps(1)
    expect(k.sent).toHaveLength(1)
    k.advance(40 * MS_PER_SECOND)
    await k.taps(1)
    expect(k.sent).toHaveLength(2)
  })

  it('sends the ID token in the body of POST /api/liff/session, never in the URL', async () => {
    const k = keeperWith(ok)
    expect(await k.keeper.signIn()).toEqual({ ok: true })
    const [request] = k.sent
    expect(request!.url).toBe(LIFF_SESSION_ENDPOINT)
    expect(request!.url).not.toContain(TOKEN)
    expect(request!.init?.method).toBe('POST')
    expect(request!.init?.credentials).toBe('same-origin')
    expect(JSON.parse(String(request!.init?.body))).toEqual({ idToken: TOKEN })
  })

  it('never renews a password sign-in, or a page without a session, with the LINE account of the browser', async () => {
    const web = keeperWith(ok)
    web.keeper.seen('web')
    web.advance(2 * SESSION_IDLE_LIFF_MS)
    await web.taps(8)
    expect(web.sent).toHaveLength(0)
    const none = keeperWith(ok)
    none.keeper.seen(null)
    none.advance(2 * SESSION_IDLE_LIFF_MS)
    await none.taps(8)
    expect(none.sent).toHaveLength(0)
  })

  it('renews a session the page opened itself with LINE (the gate signed in), and parallel sign-ins share one request', async () => {
    const k = keeperWith(ok)
    k.keeper.seen(null)
    const [a, b] = await Promise.all([k.keeper.signIn(), k.keeper.signIn()])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(k.sent).toHaveLength(1)
    k.advance(LIFF_RENEW_AFTER_MS)
    await k.taps(3)
    expect(k.sent).toHaveLength(2)
  })
})

describe('[NFR-SEC-05] a renewal LINE or BCS refused is not sent again on every tap', () => {
  for (const [what, status, body] of [
    ['not linked any more (403 LINK_REQUIRED)', 403, { code: 'FORBIDDEN', reason: 'LINK_REQUIRED' }],
    ['linked to two sign-ins (403 LINK_AMBIGUOUS)', 403, { code: 'FORBIDDEN', reason: 'LINK_AMBIGUOUS' }],
    ['a token LINE no longer accepts (401)', 401, { code: 'TOKEN_INVALID' }],
    ['a request BCS refuses (400)', 400, { code: 'VALIDATION_FAILED' }],
  ] as const) {
    it(`asks once and stops for the page load after ${what}`, async () => {
      const k = keeperWith(refused(status, body))
      k.keeper.seen('liff')
      k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
      await k.taps(8)
      expect(k.sent).toHaveLength(1)
      // Minutes of typing later, still nothing: the session idles out and the gate of the next page signs in again
      k.advance(10 * MS_PER_MINUTE)
      await k.taps(8)
      expect(k.sent).toHaveLength(1)
    })
  }

  it('tries again at most once a minute while LINE or BCS cannot be reached', async () => {
    const k = keeperWith(refused(503, { code: 'EXTERNAL_SERVICE_ERROR' }))
    k.keeper.seen('liff')
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    await k.taps(8)
    expect(k.sent).toHaveLength(1)
    k.advance(LIFF_RENEW_RETRY_MS - 30 * MS_PER_SECOND)
    await k.taps(3)
    expect(k.sent).toHaveLength(2)
    await k.taps(8)
    expect(k.sent).toHaveLength(2)
    expect(LIFF_RENEW_RETRY_MS).toBe(MS_PER_MINUTE)
  })

  it('counts an attempt whose request never got an answer, and one whose token could not be had', async () => {
    const offline = keeperWith(() => new TypeError('Failed to fetch'))
    offline.keeper.seen('liff')
    offline.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    await offline.taps(6)
    expect(offline.sent).toHaveLength(1)
    const noToken = keeperWith(ok, { token: new Error('the fake LINE server is down') })
    noToken.keeper.seen('liff')
    noToken.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    await noToken.taps(6)
    // No request: the token could not be had (once a minute it is asked for again)
    expect(noToken.sent).toHaveLength(0)
    expect(await noToken.keeper.signIn()).toEqual({ ok: false, reason: 'UNAVAILABLE' })
  })

  it('outside the LINE app there is no token: no request, and no more renewals', async () => {
    const k = keeperWith(ok, { token: null })
    expect(await k.keeper.signIn()).toEqual({ ok: false, reason: 'NOT_IN_LINE' })
    k.keeper.seen('liff')
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    await k.taps(5)
    expect(k.sent).toHaveLength(0)
  })

  it('starts renewing again once the gate signed in', async () => {
    let refuse = true
    const k = keeperWith(() => (refuse ? Response.json({ code: 'FORBIDDEN', reason: 'LINK_REQUIRED' }, { status: 403 }) : Response.json({ ok: true })))
    k.keeper.seen('liff')
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    await k.taps(3)
    expect(k.sent).toHaveLength(1)
    refuse = false
    expect(await k.keeper.signIn()).toEqual({ ok: true })
    k.advance(LIFF_RENEW_AFTER_MS)
    await k.taps(3)
    expect(k.sent).toHaveLength(3)
  })
})

describe('[FR-AUTH-003/AC1] before a server action, the page learns whether its LIFF session can be kept', () => {
  it('answers ok when nothing is due, after a renewal, and for a password session, which is never renewed with LINE', async () => {
    const k = keeperWith(ok)
    k.keeper.seen('liff')
    expect(await k.keeper.renewIfDue()).toEqual({ ok: true })
    expect(k.sent).toHaveLength(0)
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    expect(await k.keeper.renewIfDue()).toEqual({ ok: true })
    expect(k.sent).toHaveLength(1)
    const web = keeperWith(ok)
    web.keeper.seen('web')
    web.advance(2 * SESSION_IDLE_LIFF_MS)
    expect(await web.keeper.renewIfDue()).toEqual({ ok: true })
    expect(web.sent).toHaveLength(0)
  })

  for (const [what, status, body, reason] of [
    ['a token LINE no longer accepts (401)', 401, { code: 'TOKEN_INVALID' }, 'TOKEN_INVALID'],
    ['a LINE account that is not linked any more (403 LINK_REQUIRED)', 403, { code: 'FORBIDDEN', reason: 'LINK_REQUIRED' }, 'LINK_REQUIRED'],
  ] as const) {
    it(`says the session cannot be kept on this page load after ${what}, every time it is asked, without asking LINE again`, async () => {
      const k = keeperWith(refused(status, body))
      k.keeper.seen('liff')
      k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
      // A tap renews first and is refused; the action that follows learns it instead of being sent with an ended session
      await k.taps(1)
      expect(await k.keeper.renewIfDue()).toEqual({ ok: false, reason, final: true })
      k.advance(5 * MS_PER_MINUTE)
      expect(await k.keeper.renewIfDue()).toEqual({ ok: false, reason, final: true })
      expect(k.sent).toHaveLength(1)
    })
  }

  it('says when LINE or BCS could not be reached just now, which is not final: the session may still have minutes left', async () => {
    let down = true
    const k = keeperWith(() => (down ? Response.json({ code: 'EXTERNAL_SERVICE_ERROR' }, { status: 503 }) : Response.json({ ok: true })))
    k.keeper.seen('liff')
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    expect(await k.keeper.renewIfDue()).toEqual({ ok: false, reason: 'UNAVAILABLE', final: false })
    down = false
    k.advance(LIFF_RENEW_RETRY_MS)
    expect(await k.keeper.renewIfDue()).toEqual({ ok: true })
    expect(k.sent).toHaveLength(2)
  })

  it('a check asked while a renewal is on its way waits for it and shares its answer', async () => {
    const k = keeperWith(refused(401, { code: 'TOKEN_INVALID' }))
    k.keeper.seen('liff')
    k.advance(LIFF_RENEW_AFTER_MS + MS_PER_MINUTE)
    const [tap, action] = await Promise.all([k.keeper.renewIfDue(), k.keeper.renewIfDue()])
    expect(tap).toEqual({ ok: false, reason: 'TOKEN_INVALID', final: true })
    expect(action).toEqual(tap)
    expect(k.sent).toHaveLength(1)
  })
})

describe('[BR-LINE-01] with LIFF_MOCK only the source of the ID token changes', () => {
  it('asks POST /api/liff/mock-token for the LINE user the page stands for, in the body', async () => {
    const sent: Sent[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), init })
      return Response.json({ idToken: TOKEN })
    }) as typeof fetch
    expect(await mockIdToken(fetchImpl, 'U0123456789abcdef0123456789abcdef')).toBe(TOKEN)
    expect(sent[0]!.url).toBe(LIFF_MOCK_TOKEN_ENDPOINT)
    expect(JSON.parse(String(sent[0]!.init?.body))).toEqual({ lineUserId: 'U0123456789abcdef0123456789abcdef' })
    const refusedFetch = (async () => new Response(null, { status: 404 })) as typeof fetch
    await expect(mockIdToken(refusedFetch, 'U0123456789abcdef0123456789abcdef')).rejects.toThrow('404')
  })
})
