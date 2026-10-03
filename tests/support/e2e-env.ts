// Environment for end-to-end runs (plan: runtime partitioning): its own database (bcs_e2e), its own port (3100)
// and build folder, so it never touches the developer database or the `next dev` server on :3000.
export const E2E_DB = process.env.BCS_E2E_DB ?? 'bcs_e2e'
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100)
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`
/** The transaction PIN the e2e seed gives every demo approver (SEED_DEV_PIN; passes the PIN rules of FR-AUTH-005 AC1) */
export const E2E_PIN = '739164'

/**
 * The fake LINE server of the run (scripts/fake-line.ts, started by playwright.config.ts before the app): the app's LINE
 * client and LIFF verify call it, and tests read what was sent or ask it for a LIFF ID token (POST /__fake/id-token).
 * A parallel run picks its own port with E2E_FAKE_LINE_PORT.
 */
export const E2E_FAKE_LINE_PORT = Number(process.env.E2E_FAKE_LINE_PORT ?? 4180)
export const E2E_FAKE_LINE_URL = `http://127.0.0.1:${E2E_FAKE_LINE_PORT}`

/**
 * The demo organization's LINE channel in e2e runs: values in LINE's formats for tests only (not secrets of any real
 * channel). The seed saves them through the settings command (seedLineChannel), the fake accepts only this token and
 * signs test webhooks with this secret, and the LIFF ID's channel is the LIFF channel of the ID tokens the fake issues.
 */
export const E2E_LINE = {
  LINE_PROVIDER_ID: 'e2e-provider',
  LINE_MESSAGING_CHANNEL_ID: '2000000001',
  LINE_MESSAGING_CHANNEL_SECRET: 'e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0',
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: 'e2e-only-channel-access-token-0000000000000',
  LINE_LOGIN_CHANNEL_ID: '2000000002',
  LINE_LIFF_CHANNEL_ID: '2000000002',
  NEXT_PUBLIC_LIFF_ID: '2000000002-e2eLiffApp',
} as const

/** Variables the fake LINE server of the run starts with */
export function fakeLineEnv(): Record<string, string> {
  return {
    APP_ENV: 'local',
    FAKE_LINE_PORT: String(E2E_FAKE_LINE_PORT),
    LINE_MESSAGING_CHANNEL_SECRET: E2E_LINE.LINE_MESSAGING_CHANNEL_SECRET,
    LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: E2E_LINE.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN,
  }
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

/** Variables the e2e server and its setup run with (on top of .env). */
export function e2eEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!env.DATABASE_URL || !env.DIRECT_URL) throw new Error('DATABASE_URL and DIRECT_URL must be set (.env)')
  return {
    APP_ENV: 'local',
    DATABASE_URL: withDatabase(env.DATABASE_URL, E2E_DB),
    DIRECT_URL: withDatabase(env.DIRECT_URL, E2E_DB),
    APP_URL: E2E_BASE_URL,
    BETTER_AUTH_URL: E2E_BASE_URL,
    // A parallel run (one per agent) builds into its own folder under .e2e-runs/ (E2E_DIST_DIR)
    NEXT_DIST_DIR: env.E2E_DIST_DIR ?? '.next-e2e',
    SEED_DEV_PIN: E2E_PIN,
    // LINE goes to the fake server of the run; LIFF pages open in an ordinary browser with ID tokens from the fake
    ...E2E_LINE,
    LINE_API_BASE_URL: E2E_FAKE_LINE_URL,
    LINE_DATA_API_BASE_URL: E2E_FAKE_LINE_URL,
    LIFF_MOCK: '1',
  }
}
