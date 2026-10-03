import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getEnv } from '@/lib/env'
import { setLiffVerification, verifyLiffIdToken } from '@/server/auth/liff'
import { withFakeLine } from '../support/fake-line'

// The fake LINE server stands in for LINE's verify endpoint in local development and e2e (LIFF_MOCK): the app's own
// verifier (src/server/auth/liff.ts, unchanged) accepts the ID tokens the fake issued for the LIFF channel and refuses an
// unknown, expired or wrong-audience one (BR-LINE-02), exactly as it would with LINE.

const LIFF_CHANNEL = '2000000001'
const USER = 'U0123456789abcdef0123456789abcdef'
const line = withFakeLine()

beforeAll(() => {
  // liff.ts posts to `${LINE_API_BASE_URL}/oauth2/v2.1/verify`; here that address is the fake
  const base = getEnv().LINE_API_BASE_URL
  setLiffVerification({ channelId: LIFF_CHANNEL, fetch: (input, init) => fetch(String(input).replace(base, line.fake.url), init) })
})
afterAll(() => setLiffVerification(null))

describe('[BR-LINE-02] ID tokens from the fake LINE server pass the app verifier only when LINE would pass them', () => {
  it('accepts a token the fake issued for the LIFF channel and reads the LINE user id from it', async () => {
    const idToken = line.fake.issueIdToken({ sub: USER, aud: LIFF_CHANNEL })
    expect(await verifyLiffIdToken(idToken, new Date())).toEqual({ ok: true, lineUserId: USER })
  })

  it('refuses an unknown, an expired and a wrong-audience token', async () => {
    const tokens = [
      'eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl',
      line.fake.issueIdToken({ sub: USER, aud: LIFF_CHANNEL, expiresInSeconds: -5 }),
      line.fake.issueIdToken({ sub: USER, aud: '1999999999' }),
    ]
    for (const idToken of tokens) expect(await verifyLiffIdToken(idToken, new Date())).toEqual({ ok: false, reason: 'INVALID' })
  })
})
