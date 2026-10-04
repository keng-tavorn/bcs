// LIFF_MOCK (APP_ENV=local only, refused elsewhere by src/lib/env.ts): LIFF pages open in an ordinary browser, and the
// LINE user they stand for is chosen with this cookie — by an e2e test (tests/e2e/liff-support.ts) or a developer. The
// layout reads it only in mock mode and hands it to the bootstrap, which asks POST /api/liff/mock-token for an ID token
// of the fake LINE server for that user. Without the cookie the browser is "outside LINE". A LINE user id is not a
// secret; the ID token never goes into a cookie, a URL or a log. No imports: the e2e helpers read the name from here.

export const LIFF_MOCK_USER_COOKIE = 'bcs-liff-mock-user'

/** A LINE user id as LINE writes them in paths: U and letters or digits (as src/integrations/line accepts them) */
export const MOCK_LINE_USER_ID = /^U[0-9A-Za-z]{1,64}$/

/** The LINE user of the cookie, or null when there is none or it is not a LINE user id */
export function mockLineUserOf(value: string | undefined): string | null {
  return value !== undefined && MOCK_LINE_USER_ID.test(value) ? value : null
}
