import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'
import { E2E_BASE_URL as BASE_URL, E2E_PORT as PORT, e2eEnv } from './tests/support/e2e-env'

// e2e runs against a production build on its own port, build folder and database (bcs_e2e, reset and seeded by
// tests/e2e/prepare-db.ts before the server starts) so it never clashes with the shared `next dev` on :3000.

/** A parallel run keeps its screenshots and report apart (E2E_OUTPUT_DIR under .e2e-runs/); verify reads test-results/ */
const OUTPUT_DIR = process.env.E2E_OUTPUT_DIR ?? 'test-results'

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
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: `pnpm exec tsx --env-file-if-exists=.env tests/e2e/prepare-db.ts && pnpm build && pnpm start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 600_000,
    env: e2eEnv(),
  },
})
