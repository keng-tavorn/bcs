import path from 'node:path'
import { devices } from '@playwright/test'
import base from '../../playwright.config'
import { E2E_P2DEMO, E2E_PORT } from '../../tests/support/e2e-env'

// S7-18: the screen review of S7's pages (scripts/design-review/s7-pages.spec.ts), run in p2demo mode:
//   E2E_P2DEMO=1 pnpm exec playwright test --config scripts/design-review/s7.config.ts
// plays the @p2demo scenes on a fresh SIMEC database first (the records the pages show), then takes the pictures. With
// DESIGN_REVIEW_REUSE=1 it takes the pictures again on a database the scenes already played on (BCS_E2E_DB) with the
// build already in E2E_DIST_DIR: no seed, no build, no scenes.
if (!E2E_P2DEMO) throw new Error('the screen review of S7 runs in p2demo mode: set E2E_P2DEMO=1')
/** Playwright runs a config's servers and folders from the config's own folder: these are the repository's */
const ROOT = path.resolve(import.meta.dirname, '../..')
const OUTPUT_DIR = path.resolve(ROOT, process.env.E2E_OUTPUT_DIR ?? 'test-results')
const reuse = process.env.DESIGN_REVIEW_REUSE === '1'
const desktop = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!]
const pages = { name: 's7-pages', testDir: path.join(ROOT, 'scripts/design-review'), testMatch: 's7-pages.spec.ts', use: desktop }

const config = {
  ...base,
  outputDir: OUTPUT_DIR,
  reporter: [['list'], ['json', { outputFile: path.join(OUTPUT_DIR, 'e2e-results.json') }]],
  projects: reuse ? [pages] : [{ name: 'p2demo', testDir: path.join(ROOT, 'tests/e2e'), testMatch: '**/p2demo/*.spec.ts', use: desktop }, { ...pages, dependencies: ['p2demo'] }],
  webServer: (reuse ? [servers[0]!, { ...servers[1]!, command: `pnpm start -p ${E2E_PORT}` }] : servers).map((s) => ({ ...s, cwd: ROOT })),
}

export default config
