import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { functions } from '@/server/jobs'
import { DemoResetEventData, runStagingDemoReset, STAGING_DEMO_RESET_EVENT, stagingDemoReset, type DemoResetDeps } from '@/server/jobs/staging-demo-reset'
import { STAGING_DEMO_DATA_CONCURRENCY, stagingFirstSeed, type FirstSeedBase, type FirstSeedStep } from '@/server/jobs/staging-first-seed'
import { wipeAllData, wipeStatement } from '@/server/db/sql/staging-wipe'
import { demoResetConfirmation, otherOrganizations } from '@/server/services/demo-seed'
import { thaiToday } from '../../scripts/demo-reset'
import { migratorUrl, withDatabase } from '../../scripts/lib/db-urls'
import { createOrg } from '../support/factory'

// The demo reset of staging runs as an Inngest job on Vercel, started by the owner with today's confirmation (ADR-056,
// D-07). Registration on staging: tests/integration/job-cadence-staging.test.ts.

const PASSWORD = 'x'.repeat(PASSWORD_MIN_LENGTH)
const NOW = new Date('2026-10-20T02:00:00Z') // 09:00 in Bangkok
const BASE: FirstSeedBase = { organizationId: 'org-1', orgCode: 'DEMO', members: 18, twoFactor: 14, doaVersions: 1, budgetLines: 5, suppliers: 5 }

function harness(overrides: Partial<DemoResetDeps> = {}) {
  const calls: string[] = []
  const step: FirstSeedStep = {
    run: async (id, fn) => {
      calls.push(`step:${id}`)
      return fn()
    },
  }
  const deps: DemoResetDeps = {
    appEnv: 'staging',
    password: PASSWORD,
    confirm: 'DEMO-2026-10-20',
    now: () => NOW,
    demoOrgCode: async () => 'DEMO',
    otherOrganizations: async () => {
      calls.push('others')
      return []
    },
    preflight: async () => {
      calls.push('preflight')
    },
    wipe: async () => {
      calls.push('wipe')
      return 120
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
  return { calls, run: () => runStagingDemoReset(step, deps) }
}

describe('the staging demo reset wipes only after today\'s confirmation (ADR-056, D-07, spec §17.4)', () => {
  it('[FR-PLT-007/AC2] refuses outside staging and without a seed password, before it reads anything', async () => {
    for (const appEnv of ['local', 'preview', 'production'] as const) {
      const { calls, run } = harness({ appEnv })
      expect(await run()).toEqual({ reset: false, refusal: 'NOT_STAGING' })
      expect(calls).toEqual(['step:check'])
    }
    const { calls, run } = harness({ password: undefined })
    expect(await run()).toEqual({ reset: false, refusal: 'NO_SEED_PASSWORD' })
    expect(calls).toEqual(['step:check'])
  })

  it('[FR-PLT-007/AC2] wipes nothing without the confirmation of today, and says what to type', async () => {
    for (const confirm of [undefined, '', 'DEMO', 'DEMO-2026-10-19', 'demo-2026-10-20', 'LKR-2026-10-20']) {
      const { calls, run } = harness({ confirm })
      expect(await run(), String(confirm)).toEqual({ reset: false, refusal: 'CONFIRMATION_MISMATCH', expected: 'DEMO-2026-10-20' })
      expect(calls).toEqual(['step:check'])
    }
  })

  it('[FR-PLT-007/AC2] wipes nothing while staging holds an organization that is not the demo one', async () => {
    const { calls, run } = harness({ otherOrganizations: async () => ['ACME'] })
    expect(await run()).toEqual({ reset: false, refusal: 'OTHER_ORGANIZATIONS', others: ['ACME'] })
    expect(calls).toEqual(['step:check'])
  })

  it('[FR-PLT-007/AC2] checks the inputs and the bucket first, then wipes, seeds the base and its history in that order', async () => {
    const { calls, run } = harness()
    expect(await run()).toEqual({ reset: true, tables: 120, ...BASE, history: { COMPLETED: 9 } })
    expect(calls).toEqual(['step:check', 'others', 'preflight', 'step:wipe', 'wipe', 'step:base', 'seedBase', 'step:history', 'seedHistory:org-1'])
  })

  it('[FR-PLT-007/AC2] touches nothing when the inputs or the bucket fail', async () => {
    const { calls, run } = harness({
      preflight: async () => {
        throw new Error('bucket did not answer')
      },
    })
    await expect(run()).rejects.toThrow('bucket did not answer')
    expect(calls).toEqual(['step:check', 'others'])
  })

  it('[FR-PLT-007/AC2] asks for the same confirmation as pnpm demo:reset: the demo code and today in Thai time', () => {
    expect(demoResetConfirmation('DEMO', NOW)).toBe('DEMO-2026-10-20')
    // 00:30 on 21 October in Bangkok is still 20 October in UTC
    const lateNight = new Date('2026-10-20T17:30:00Z')
    expect(demoResetConfirmation('DEMO', lateNight)).toBe('DEMO-2026-10-21')
    for (const at of [NOW, lateNight]) expect(demoResetConfirmation('DEMO', at)).toBe(`DEMO-${thaiToday(at)}`)
    expect(DemoResetEventData.parse({ confirm: 'DEMO-2026-10-20' }).confirm).toBe('DEMO-2026-10-20')
    expect(DemoResetEventData.parse({}).confirm).toBeUndefined()
  })

  it('[FR-PLT-007/AC2] lists every organization of the database that is not the demo one', async () => {
    const org = await createOrg()
    const others = await otherOrganizations('DEMO')
    expect(others).toContain(org.code)
    expect(others).not.toContain('DEMO')
  })

  it('[EG-3] is started by its own event, never retried, and shares one concurrency group with the first seed', () => {
    expect(STAGING_DEMO_RESET_EVENT).toBe('bcs/staging.demo_reset_requested')
    expect(stagingDemoReset.opts).toMatchObject({ id: 'staging-demo-reset', retries: 0, concurrency: STAGING_DEMO_DATA_CONCURRENCY, triggers: [{ event: STAGING_DEMO_RESET_EVENT }] })
    expect(stagingFirstSeed.opts.concurrency).toEqual(STAGING_DEMO_DATA_CONCURRENCY)
    expect(STAGING_DEMO_DATA_CONCURRENCY).toEqual({ limit: 1, scope: 'env', key: '"staging-demo-data"' })
  })

  it('[EG-3] is not served outside staging', () => {
    expect(functions.map((f) => f.opts.id)).not.toContain('staging-demo-reset')
  })
})

describe('the wipe empties every table but the migration record, as the migrator (ADR-056)', () => {
  const database = `bcs_wipe_probe_${randomUUID().slice(0, 8)}`
  const admin = () => new pg.Client({ connectionString: migratorUrl() })

  afterAll(async () => {
    const c = admin()
    await c.connect()
    try {
      await c.query(`drop database if exists "${database}" with (force)`)
    } finally {
      await c.end()
    }
  })

  it('[FR-PLT-007/AC2] quotes every table, leaves _prisma_migrations out, and has nothing to say for an empty schema', () => {
    expect(wipeStatement(['_prisma_migrations', 'Event', 'Odd"Name'])).toBe('TRUNCATE TABLE public."Event", public."Odd""Name" RESTART IDENTITY CASCADE')
    expect(wipeStatement(['_prisma_migrations'])).toBeNull()
    expect(wipeStatement([])).toBeNull()
  })

  it('[FR-PLT-007/AC2] empties append-only and linked tables, restarts their identities and keeps the migration record (real Postgres)', async () => {
    const c = admin()
    await c.connect()
    try {
      await c.query(`create database "${database}"`)
    } finally {
      await c.end()
    }
    const url = withDatabase(migratorUrl(), database)
    const db = new pg.Client({ connectionString: url })
    await db.connect()
    try {
      await db.query(`create table "_prisma_migrations" (id text primary key)`)
      await db.query(`insert into "_prisma_migrations" values ('20261002024508_s1_platform')`)
      await db.query(`create table "Ledger" (id integer generated always as identity primary key, note text)`)
      await db.query(`create table "Line" (id serial primary key, ledger integer references "Ledger"(id))`)
      // Like the append-only tables (§6.3): rows can never be changed or deleted, but TRUNCATE fires no row trigger
      await db.query(`create function forbid() returns trigger language plpgsql as $$ begin raise exception 'append-only'; end $$`)
      await db.query(`create trigger forbid_mutation before update or delete on "Ledger" for each row execute function forbid()`)
      await db.query(`insert into "Ledger" (note) values ('a'), ('b')`)
      await db.query(`insert into "Line" (ledger) values (1), (2)`)
      await expect(db.query(`delete from "Ledger"`)).rejects.toThrow('append-only')

      expect(await wipeAllData(url)).toBe(2)

      expect((await db.query(`select count(*)::int as n from "Ledger"`)).rows[0].n).toBe(0)
      expect((await db.query(`select count(*)::int as n from "Line"`)).rows[0].n).toBe(0)
      expect((await db.query(`select id from "_prisma_migrations"`)).rows).toEqual([{ id: '20261002024508_s1_platform' }])
      expect((await db.query(`insert into "Ledger" (note) values ('fresh') returning id`)).rows[0].id).toBe(1)
      expect(await wipeAllData(url)).toBe(2)
    } finally {
      await db.end()
    }
  })
})
