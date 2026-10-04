import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// S5-06 · POST /api/liff/mock-token (LIFF_MOCK, local only): it gives a LIFF page in an ordinary browser an ID token the
// fake LINE server issued for this environment's LIFF channel, and nothing anywhere else — on staging and production it
// answers 404 as if it did not exist and never calls anything, even if LIFF_MOCK were set there (src/lib/env.ts refuses
// it outside local; this is the route's own guard). The token is in the answer's body only, never in a URL. The real
// sign-in path with such a token runs in tests/integration/liff-shell.test.ts and the e2e specs.

const ENV = vi.hoisted(() => ({
  value: {
    APP_ENV: 'local' as 'local' | 'preview' | 'staging' | 'production',
    LIFF_MOCK: true as boolean | undefined,
    APP_URL: 'http://localhost:3133',
    LINE_API_BASE_URL: 'http://127.0.0.1:4183',
    LINE_LIFF_CHANNEL_ID: '2000000002' as string | undefined,
  },
}))

vi.mock('@/lib/env', () => ({ getEnv: () => ENV.value }))
// The same-site check of every LIFF request (tested with the LIFF session in tests/integration/liff-session.test.ts),
// without the database modules that come with it
vi.mock('@/server/auth/liff', () => ({
  isLiffRequestFromThisSite: (headers: Headers | undefined) => {
    const origin = headers?.get('origin')
    return !origin || origin === new URL(ENV.value.APP_URL).origin
  },
}))

const { POST } = await import('@/app/api/liff/mock-token/route')

const ISSUED = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVZTJlIn0.c2lnbmVk'
const LINE_USER = 'U0123456789abcdef0123456789abcdef'

const fetchSpy = vi.fn<typeof fetch>()

beforeEach(() => {
  ENV.value = { APP_ENV: 'local', LIFF_MOCK: true, APP_URL: 'http://localhost:3133', LINE_API_BASE_URL: 'http://127.0.0.1:4183', LINE_LIFF_CHANNEL_ID: '2000000002' }
  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue(Response.json({ idToken: ISSUED }))
  vi.stubGlobal('fetch', fetchSpy)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const ask = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request('http://localhost:3133/api/liff/mock-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3133', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )

describe('[BR-LINE-01] the mock token route exists only with LIFF_MOCK on this machine', () => {
  it('answers 404 on staging, production and preview, and never asks anyone for a token', async () => {
    for (const APP_ENV of ['staging', 'production', 'preview'] as const) {
      ENV.value = { ...ENV.value, APP_ENV, LIFF_MOCK: true, LINE_API_BASE_URL: 'https://api.line.me' }
      const response = await ask({ lineUserId: LINE_USER })
      expect(response.status, APP_ENV).toBe(404)
      expect(await response.text(), APP_ENV).toBe('')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('answers 404 on this machine too when LIFF_MOCK is off', async () => {
    for (const LIFF_MOCK of [false, undefined]) {
      ENV.value = { ...ENV.value, LIFF_MOCK }
      expect((await ask({ lineUserId: LINE_USER })).status).toBe(404)
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('with LIFF_MOCK on, has the fake LINE server issue a token for that LINE user and this LIFF channel, in the body only', async () => {
    const response = await ask({ lineUserId: LINE_USER })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ idToken: ISSUED })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:4183/__fake/id-token')
    expect(String(url)).not.toContain(ISSUED)
    expect(JSON.parse(String(init?.body))).toEqual({ sub: LINE_USER, aud: '2000000002' })
  })

  it('takes { lineUserId } and nothing else, from a page of this site only', async () => {
    expect((await ask({ lineUserId: 'not-a-line-user' })).status).toBe(400)
    expect((await ask({ lineUserId: LINE_USER, idToken: 'x' })).status).toBe(400)
    expect((await ask('not json')).status).toBe(400)
    expect((await ask({ lineUserId: LINE_USER }, { origin: 'https://attacker.example' })).status).toBe(403)
    expect((await ask({ lineUserId: `U${'a'.repeat(2000)}` })).status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says the fake LINE server could not be asked, without a token', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'))
    const down = await ask({ lineUserId: LINE_USER })
    expect(down.status).toBe(502)
    expect(await down.json()).toEqual({ ok: false, code: 'EXTERNAL_SERVICE_ERROR', service: 'LINE' })
    ENV.value = { ...ENV.value, LINE_LIFF_CHANNEL_ID: undefined }
    expect((await ask({ lineUserId: LINE_USER })).status).toBe(503)
  })
})
