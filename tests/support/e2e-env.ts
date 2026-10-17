// Environment for end-to-end runs (plan: runtime partitioning): its own database (bcs_e2e), its own port (3100)
// and build folder, so it never touches the developer database or the `next dev` server on :3000.

// The demo scenes (D-04, tests/e2e/demo) run alone against a database seeded with the demo history (D-01):
// `pnpm test:e2e --grep @demo` or E2E_DEMO=1. The flag goes into the environment so Playwright's workers and the
// web server's setup (tests/e2e/prepare-db.ts), which do not see the command line, agree with the main process.
if (process.argv.some((arg) => arg.includes('@demo'))) process.env.E2E_DEMO = '1'
export const E2E_DEMO = process.env.E2E_DEMO === '1'
// The scenes of phase 1 (P1-08, tests/e2e/p1demo) the same way, on a database seeded with SIMEC from the phase-1
// workbook and its history: `pnpm test:e2e --grep @p1demo` or E2E_P1DEMO=1 ("@p1demo" does not contain "@demo")
if (process.argv.some((arg) => arg.includes('@p1demo'))) process.env.E2E_P1DEMO = '1'
export const E2E_P1DEMO = process.env.E2E_P1DEMO === '1'
if (E2E_DEMO && E2E_P1DEMO) throw new Error('E2E_DEMO and E2E_P1DEMO are two runs on two databases: run @demo and @p1demo one after the other')
export const E2E_DB = process.env.BCS_E2E_DB ?? (E2E_DEMO ? 'bcs_e2e_demo' : E2E_P1DEMO ? 'bcs_e2e_p1demo' : 'bcs_e2e')
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
    E2E_DEMO: E2E_DEMO ? '1' : '0',
    E2E_P1DEMO: E2E_P1DEMO ? '1' : '0',
    // AI in fixture mode (ADR-142): nothing shows while an organization keeps the AI module off, as the demo's does; the
    // AI specs switch it on for themselves (tests/e2e/ai-document-scene.ts) and play the background job there
    AI_ENABLED: 'true',
    AI_MODE: 'fixture',
    // The recorded answers belong to the models the agents ask for by default (OQ-145): a model chosen in this computer's
    // .env would find none of them (AI_MODEL_MISMATCH), so e2e asks for the defaults, as CI does (.env.example leaves these blank)
    AI_MODEL_DEFAULT: '',
    AI_MODEL_DOCUMENT: '',
    AI_MODEL_INTAKE: '',
    AI_MODEL_BRIEF: '',
    AI_MODEL_INSIGHT: '',
    AI_MODEL_DOA_DRAFTER: '',
  }
}
