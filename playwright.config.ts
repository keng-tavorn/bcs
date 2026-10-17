import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'
import { E2E_BASE_URL as BASE_URL, E2E_DEMO, E2E_FAKE_LINE_URL, E2E_P1DEMO, E2E_PORT as PORT, e2eEnv, fakeLineEnv } from './tests/support/e2e-env'

// e2e runs against a production build on its own port, build folder and database (bcs_e2e, reset and seeded by
// tests/e2e/prepare-db.ts before the server starts) so it never clashes with the shared `next dev` on :3000.

/** A parallel run keeps its screenshots and report apart (E2E_OUTPUT_DIR under .e2e-runs/); verify reads test-results/ */
const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? 'test-results'

/** LIFF pages live in the LINE app on phones (§9.4): their specs run at 375 px only */
const LIFF_SPECS = '**/liff-*.spec.ts'
/** The scenes of S17 (BCS Go and LIFF, tests/e2e/s17.spec.ts) are phone screens too */
const PHONE_SCENES = '**/s17.spec.ts'
/** The demo scenes (D-04) run only in demo mode, against the database with the demo history (tests/support/e2e-env.ts) */
const DEMO_SPECS = '**/demo/**'
/** Only the scene files run; tests/e2e/demo/support.ts and scripts/ are helpers the scenes import */
const DEMO_SCENES = '**/demo/*.spec.ts'
/** The scenes of phase 1 (P1-08) the same way, in their own mode on the database seeded with SIMEC (tests/support/e2e-env.ts) */
const P1DEMO_SPECS = '**/p1demo/**'
const P1DEMO_SCENES = '**/p1demo/*.spec.ts'

const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
const mobile = { ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: OUTPUT_DIR,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: `${OUTPUT_DIR}/e2e-results.json` }]],
  use: {
    baseURL: BASE_URL,
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Demo mode runs the scenes in file order on one database, one after another: each scene builds on the ones before
  // it, as on the day; a scene file picks its own device (the LIFF scenes a phone, the web scenes a desktop)
  projects: E2E_DEMO
    ? [{ name: 'demo', testMatch: DEMO_SCENES, use: desktop }]
    : E2E_P1DEMO
      ? [{ name: 'p1demo', testMatch: P1DEMO_SCENES, use: desktop }]
      : [
          { name: 'desktop', testIgnore: [LIFF_SPECS, PHONE_SCENES, DEMO_SPECS, P1DEMO_SPECS], use: desktop },
          { name: 'mobile', testIgnore: [DEMO_SPECS, P1DEMO_SPECS], use: mobile },
        ],
  webServer: [
    // The fake LINE server of the run (Messaging API, LIFF verify, rich menus): the app's LINE client points at it
    {
      command: 'pnpm exec tsx scripts/fake-line.ts',
      url: `${E2E_FAKE_LINE_URL}/__fake/state`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: fakeLineEnv(),
    },
    {
      command: `pnpm exec tsx --env-file-if-exists=.env tests/e2e/prepare-db.ts && pnpm build && pnpm start -p ${PORT}`,
      url: BASE_URL,
      reuseExistingServer: false,
      // The phase-1 seed with its history takes 4 to 11 minutes before the build starts (P1-08, slower under load)
      timeout: E2E_P1DEMO ? 1_800_000 : 600_000,
      env: e2eEnv(),
    },
  ],
})
