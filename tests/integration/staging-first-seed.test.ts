import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { functions } from '@/server/jobs'
import {
  databaseTakesFirstSeed,
  environmentRefusal,
  runStagingFirstSeed,
  STAGING_FIRST_SEED_EVENT,
  stagingFirstSeed,
  type FirstSeedBase,
  type FirstSeedDeps,
  type FirstSeedStep,
} from '@/server/jobs/staging-first-seed'
import { ORG_SETTINGS_DEMO_PATH } from '@/server/seed/demo-org'
import { SEED_FORMS_PATH } from '@/server/seed/forms'
import { TAX_RATES_PATH } from '@/server/seed/tax-rates'
import { INPUT_WORKBOOK_PATH } from '@/server/seed/workbook'
import { demoHistoryStarted } from '@/server/services/demo-history'
import { firstSeedState, type FirstSeedState } from '@/server/services/demo-seed'
import { createOrg } from '../support/factory'

// The first seed of staging runs as an Inngest job on Vercel next to the database (ADR-055). Registration on staging:
// tests/integration/job-cadence-staging.test.ts. The seed itself is the one `pnpm db:seed` runs (src/server/services/demo-seed).

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PASSWORD = 'x'.repeat(PASSWORD_MIN_LENGTH)
const EMPTY: FirstSeedState = { organizations: 0, unfinishedFirstSeed: false }
const BASE: FirstSeedBase = { organizationId: 'org-1', orgCode: 'DEMO', members: 18, twoFactor: 14, doaVersions: 1, budgetLines: 5, suppliers: 5 }

/** Runs the job's steps in order, as Inngest would on the first call of each, and records what ran */
function harness(overrides: Partial<FirstSeedDeps> = {}) {
  const calls: string[] = []
  const step: FirstSeedStep = {
    run: async (id, fn) => {
      calls.push(`step:${id}`)
      return fn()
    },
  }
  const deps: FirstSeedDeps = {
    appEnv: 'staging',
    password: PASSWORD,
    state: async () => {
      calls.push('state')
      return EMPTY
    },
    preflight: async () => {
      calls.push('preflight')
    },
    seedBase: async () => {
      calls.push('seedBase')
      return BASE
    },
    seedHistory: async (organizationId) => {
      calls.push(`seedHistory:${organizationId}`)
      return { seeded: true, byStatus: { COMPLETED: 9 } }
    },
    ...overrides,
  }
  return { calls, run: () => runStagingFirstSeed(step, deps) }
}

describe('the staging seed job seeds only an empty staging database (ADR-055, ADR-038 item 14)', () => {
  it('[FR-PLT-007/AC2] refuses outside staging and without a seed password, before it looks at the database', async () => {
    for (const appEnv of ['local', 'preview', 'production'] as const) {
      expect(environmentRefusal(appEnv, PASSWORD), appEnv).toBe('NOT_STAGING')
      const { calls, run } = harness({ appEnv })
      expect(await run()).toEqual({ seeded: false, refusal: 'NOT_STAGING' })
      expect(calls).toEqual(['step:check'])
    }
    expect(environmentRefusal('staging', undefined)).toBe('NO_SEED_PASSWORD')
    expect(environmentRefusal('staging', 'x'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe('NO_SEED_PASSWORD')
    expect(environmentRefusal('staging', PASSWORD)).toBeNull()
    const { calls, run } = harness({ password: undefined })
    expect(await run()).toEqual({ seeded: false, refusal: 'NO_SEED_PASSWORD' })
    expect(calls).toEqual(['step:check'])
  })

  it('[FR-PLT-007/AC2] writes nothing to a database that holds data: the check step returns before the base step', async () => {
    const taken: FirstSeedState[] = [
      { organizations: 1, unfinishedFirstSeed: false },
      { organizations: 2, unfinishedFirstSeed: false },
      { organizations: 2, unfinishedFirstSeed: true },
    ]
    for (const state of taken) {
      expect(databaseTakesFirstSeed(state), JSON.stringify(state)).toBe(false)
      const { calls, run } = harness({ state: async () => state })
      expect(await run()).toEqual({ seeded: false, refusal: 'NOT_EMPTY' })
      expect(calls).toEqual(['step:check'])
    }
  })

  it('[FR-PLT-007/AC2] checks the inputs and the bucket before the first write, then makes the base and its history in that order', async () => {
    const { calls, run } = harness()
    expect(await run()).toEqual({ seeded: true, ...BASE, history: { COMPLETED: 9 } })
    expect(calls).toEqual(['step:check', 'state', 'preflight', 'step:base', 'seedBase', 'step:history', 'seedHistory:org-1'])
  })

  it('[FR-PLT-007/AC2] stops before writing when the inputs or the bucket fail, so it can be started again', async () => {
    const { calls, run } = harness({
      preflight: async () => {
        throw new Error('bucket did not answer')
      },
    })
    await expect(run()).rejects.toThrow('bucket did not answer')
    expect(calls).toEqual(['step:check', 'state'])
  })

  it('[FR-PLT-007/AC2] finishes a first seed that stopped before its history, and nothing else', async () => {
    expect(databaseTakesFirstSeed(EMPTY)).toBe(true)
    expect(databaseTakesFirstSeed({ organizations: 1, unfinishedFirstSeed: true })).toBe(true)
    const { calls, run } = harness({ state: async () => ({ organizations: 1, unfinishedFirstSeed: true }) })
    expect((await run()).seeded).toBe(true)
    expect(calls).toContain('seedBase')
  })

  it('[FR-PLT-007/AC2] reads the state of the real database: every tenant counts, and a test organization is never an unfinished first seed', async () => {
    const before = await firstSeedState()
    const org = await createOrg()
    const after = await firstSeedState()
    expect(after.organizations).toBeGreaterThan(before.organizations)
    expect(after.unfinishedFirstSeed).toBe(false)
    expect(await demoHistoryStarted(org.id)).toBe(false)
  })

  it('[EG-3] is started by its own event, runs one step at a time and is never retried by Inngest', () => {
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
