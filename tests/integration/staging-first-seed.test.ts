import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { functions } from '@/server/jobs'
import { firstSeedRefusal, STAGING_FIRST_SEED_EVENT, stagingFirstSeed } from '@/server/jobs/staging-first-seed'
import { ORG_SETTINGS_DEMO_PATH } from '@/server/seed/demo-org'
import { SEED_FORMS_PATH } from '@/server/seed/forms'
import { TAX_RATES_PATH } from '@/server/seed/tax-rates'
import { INPUT_WORKBOOK_PATH } from '@/server/seed/workbook'
import { organizationCount } from '@/server/services/demo-seed'
import { createOrg } from '../support/factory'

// The first seed of staging runs as an Inngest job on Vercel next to the database (ADR-055). Registration on staging:
// tests/integration/job-cadence-staging.test.ts. The seed itself is the one `pnpm db:seed` runs (src/server/services/demo-seed).

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PASSWORD = 'x'.repeat(PASSWORD_MIN_LENGTH)

describe('the staging seed job seeds only an empty staging database (ADR-055, ADR-038 item 14)', () => {
  it('[FR-PLT-007/AC2] refuses outside staging, without a seed password, and on a database that has an organization', () => {
    expect(firstSeedRefusal('staging', PASSWORD, 0)).toBeNull()
    for (const appEnv of ['local', 'preview', 'production'] as const) expect(firstSeedRefusal(appEnv, PASSWORD, 0), appEnv).toBe('NOT_STAGING')
    expect(firstSeedRefusal('staging', undefined, 0)).toBe('NO_SEED_PASSWORD')
    expect(firstSeedRefusal('staging', 'x'.repeat(PASSWORD_MIN_LENGTH - 1), 0)).toBe('NO_SEED_PASSWORD')
    expect(firstSeedRefusal('staging', PASSWORD, 1)).toBe('NOT_EMPTY')
  })

  it('[FR-PLT-007/AC2] counts the organizations of every tenant, so any existing data stops it', async () => {
    await createOrg()
    expect(await organizationCount()).toBeGreaterThan(0)
  })

  it('[EG-3] is started by its own event, runs once at a time and is never retried by Inngest', () => {
    expect(STAGING_FIRST_SEED_EVENT).toBe('bcs/staging.first_seed_requested')
    expect(stagingFirstSeed.opts).toMatchObject({ id: 'staging-first-seed', retries: 0, concurrency: { limit: 1 }, triggers: [{ event: STAGING_FIRST_SEED_EVENT }] })
  })

  it('[EG-3] is not served outside staging', () => {
    expect(functions.map((f) => f.opts.id)).not.toContain('staging-first-seed')
  })

  it('[EG-3] reads its files from the project root, and next.config.ts ships each of them with /api/inngest', () => {
    const config = readFileSync(path.join(ROOT, 'next.config.ts'), 'utf8')
    expect(config).toContain("const SEED_FILES = ['./docs/inputs/BCS_inputs_v1_demo.xlsx', './prisma/seed/*.yaml']")
    expect(config).toContain("'/api/inngest': [...PDF_FILES, ...SEED_FILES]")
    expect(INPUT_WORKBOOK_PATH).toBe('docs/inputs/BCS_inputs_v1_demo.xlsx')
    for (const file of [ORG_SETTINGS_DEMO_PATH, SEED_FORMS_PATH, TAX_RATES_PATH]) {
      expect(file, file).toMatch(/^prisma\/seed\/[^/]+\.yaml$/)
      expect(readFileSync(path.join(ROOT, file), 'utf8').length, file).toBeGreaterThan(0)
    }
  })
})
