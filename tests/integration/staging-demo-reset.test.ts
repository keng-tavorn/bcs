import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { PASSWORD_MIN_LENGTH } from '@/lib/constants'
import { prisma } from '@/server/db/client'
import { OtherOrganizationError, wipeAllData, wipeStatement } from '@/server/db/sql/staging-wipe'
import { functions } from '@/server/jobs'
import { DemoResetEventData, runStagingDemoReset, STAGING_DEMO_RESET_EVENT, stagingDemoReset, type DemoResetDeps } from '@/server/jobs/staging-demo-reset'
import { STAGING_DEMO_DATA_CONCURRENCY, stagingFirstSeed, type FirstSeedBase, type FirstSeedStep } from '@/server/jobs/staging-first-seed'
import {
  DemoYearError,
  demoResetConfirmation,
  firstSeedPreflight,
  otherOrganizations,
  putLineChannel,
  takeLineChannel,
  type CarriedLineChannel,
} from '@/server/services/demo-seed'
import { openLineSecret, sealLineSecret } from '@/server/services/line-channel/secrets'
import { thaiToday } from '../../scripts/demo-reset'
import { migratorUrl, withDatabase } from '../../scripts/lib/db-urls'
import { createOrg } from '../support/factory'

// The demo reset of staging runs as an Inngest job on Vercel, started by the owner with today's confirmation (ADR-056,
// D-07). Registration on staging: tests/integration/job-cadence-staging.test.ts.

const PASSWORD = 'x'.repeat(PASSWORD_MIN_LENGTH)
const NOW = new Date('2026-10-20T02:00:00Z') // 09:00 in Bangkok
const BASE: FirstSeedBase = { organizationId: 'org-new', orgCode: 'DEMO', members: 18, twoFactor: 14, doaVersions: 1, budgetLines: 5, suppliers: 5 }
const LINE: CarriedLineChannel = {
  channelKey: 'key-a',
  providerId: 'p',
  messagingChannelId: 'm',
  channelSecret: 'secret',
  channelAccessToken: 'token',
  liffId: null,
  liffChannelId: null,
  richMenuLinkedId: 'richmenu-linked',
  richMenuUnlinkedId: 'richmenu-unlinked',
  active: true,
}

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
    now: () => {
      calls.push('now')
      return NOW
    },
    demoOrgCode: async () => {
      calls.push('demoOrgCode')
      return 'DEMO'
    },
    otherOrganizations: async () => {
      calls.push('others')
      return []
    },
    preflight: async () => {
      calls.push('preflight')
    },
    demoOrganizationId: async () => {
      calls.push('demoOrganizationId')
      return 'org-old'
    },
    takeLine: async (organizationId) => {
      calls.push(`takeLine:${organizationId}`)
      return { state: 'TAKEN', channel: LINE }
    },
    wipe: async (demoCode) => {
      calls.push(`wipe:${demoCode}`)
      return 120
    },
    seedBase: async () => {
      calls.push('seedBase')
      return BASE
    },
    putLine: async (organizationId, carried) => {
      calls.push(`putLine:${organizationId}:${carried.channelKey}`)
    },
    seedHistory: async (organizationId) => {
      calls.push(`seedHistory:${organizationId}`)
      return { seeded: true, byStatus: { COMPLETED: 9 } }
    },
    ...overrides,
  }
  return { calls, run: () => runStagingDemoReset(step, deps) }
}

const GUARD = ['demoOrgCode', 'now', 'others']

describe("the staging demo reset wipes only after today's confirmation (ADR-056, D-07, spec §17.4)", () => {
  it('[FR-PLT-007/AC2] refuses outside staging and without a seed password, before it reads the inputs or the clock', async () => {
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
      expect(calls).toEqual(['step:check', 'demoOrgCode', 'now'])
    }
  })

  it('[FR-PLT-007/AC2] wipes nothing while staging holds an organization that is not the demo one', async () => {
    const { calls, run } = harness({ otherOrganizations: async () => ['ACME'] })
    expect(await run()).toEqual({ reset: false, refusal: 'OTHER_ORGANIZATIONS', others: ['ACME'] })
    expect(calls).toEqual(['step:check', 'demoOrgCode', 'now'])
  })

  it('[FR-PLT-007/AC2] checks first, then in one step checks again, keeps the LINE channel, wipes, seeds the base and puts the channel back', async () => {
    const { calls, run } = harness()
    expect(await run()).toEqual({ reset: true, tables: 120, line: 'KEPT', ...BASE, history: { COMPLETED: 9 } })
    expect(calls).toEqual([
      'step:check',
      ...GUARD,
      'preflight',
      'step:reset',
      ...GUARD,
      'preflight',
      'demoOrganizationId',
      'takeLine:org-old',
      'wipe:DEMO',
      'seedBase',
      'putLine:org-new:key-a',
      'step:history',
      'seedHistory:org-new',
    ])
  })

  it('[FR-PLT-007/AC2] the reset step checks the confirmation again, so running it later on its own wipes nothing', async () => {
    // The check step passed on the 20th; the reset step runs on the 21st (a step run again from the dashboard)
    let day = 0
    const { calls, run } = harness({ now: () => (day++ === 0 ? NOW : new Date('2026-10-21T02:00:00Z')) })
    await expect(run()).rejects.toThrow('staging-demo-reset stopped before the wipe: CONFIRMATION_MISMATCH')
    expect(calls.some((c) => c.startsWith('wipe') || c.startsWith('takeLine'))).toBe(false)
  })

  it('[FR-PLT-007/AC2] says when there was no LINE channel, or one whose secrets did not open, and puts nothing back', async () => {
    for (const state of ['NONE', 'NOT_OPENED'] as const) {
      const { calls, run } = harness({ takeLine: async () => ({ state }) })
      expect(await run()).toMatchObject({ reset: true, line: state })
      expect(calls.some((c) => c.startsWith('putLine'))).toBe(false)
    }
    const { calls, run } = harness({ demoOrganizationId: async () => null })
    expect(await run()).toMatchObject({ reset: true, line: 'NONE' })
    expect(calls.some((c) => c.startsWith('takeLine'))).toBe(false)
  })

  it('[FR-PLT-007/AC2] touches nothing when the inputs, the fiscal year or the bucket fail', async () => {
    const { calls, run } = harness({
      preflight: async () => {
        throw new Error('bucket did not answer')
      },
    })
    await expect(run()).rejects.toThrow('bucket did not answer')
    expect(calls).toEqual(['step:check', ...GUARD])
  })

  it('[FR-PLT-007/AC2] asks for the same confirmation as pnpm demo:reset, typed inside "data" or not', () => {
    expect(demoResetConfirmation('DEMO', NOW)).toBe('DEMO-2026-10-20')
    // 00:30 on 21 October in Bangkok is still 20 October in UTC
    const lateNight = new Date('2026-10-20T17:30:00Z')
    expect(demoResetConfirmation('DEMO', lateNight)).toBe('DEMO-2026-10-21')
    for (const at of [NOW, lateNight]) expect(demoResetConfirmation('DEMO', at)).toBe(`DEMO-${thaiToday(at)}`)
    expect(DemoResetEventData.parse({ confirm: ' DEMO-2026-10-20 ' })).toBe('DEMO-2026-10-20')
    expect(DemoResetEventData.parse({ data: { confirm: 'DEMO-2026-10-20' } })).toBe('DEMO-2026-10-20')
    expect(DemoResetEventData.parse({})).toBeUndefined()
    expect(DemoResetEventData.safeParse({ confirm: 20261020 }).success).toBe(false)
  })

  it('[FR-PLT-007/AC2] stops before anything when today, or the first day of a history row, is outside the fiscal year', async () => {
    await expect(firstSeedPreflight(new Date('2027-01-05T03:00:00Z'))).rejects.toMatchObject({ name: 'DemoYearError', ref: null })
    // Ten days into the year, rows that start weeks back would begin in the year before
    const early = firstSeedPreflight(new Date('2026-01-10T03:00:00Z'))
    await expect(early).rejects.toBeInstanceOf(DemoYearError)
    await expect(early).rejects.toMatchObject({ ref: expect.stringMatching(/^H\d{2}$/) })
    await expect(firstSeedPreflight(NOW)).resolves.toBeUndefined()
  })

  it('[FR-PLT-007/AC2] the reset step runs the input, fiscal year and bucket checks again before it touches anything', async () => {
    let checks = 0
    const { calls, run } = harness({
      preflight: async () => {
        if (checks++ > 0) throw new Error('bucket did not answer')
      },
    })
    await expect(run()).rejects.toThrow('bucket did not answer')
    expect(calls.some((c) => c.startsWith('wipe') || c.startsWith('takeLine'))).toBe(false)
  })

  it('[FR-PLT-007/AC2] lists every organization that is not the one it is asked about', async () => {
    const [a, b] = [await createOrg(), await createOrg()]
    const others = await otherOrganizations(a.code)
    expect(others).toContain(b.code)
    expect(others).not.toContain(a.code)
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

describe('the LINE channel the owner set up comes through the reset (ADR-056)', () => {
  it('[FR-PLT-007/AC2] keeps the webhook path, the rich menus and the secrets, sealed again for the new organization', async () => {
    const before = await createOrg()
    const channelKey = `carry-${randomUUID()}`
    await prisma.lineChannelConfig.create({
      data: {
        organizationId: before.id,
        channelKey,
        providerId: 'provider-1',
        messagingChannelId: 'messaging-1',
        channelSecretEnc: sealLineSecret(before.id, 'channelSecret', 'the-secret'),
        channelAccessTokenEnc: sealLineSecret(before.id, 'channelAccessToken', 'the-token'),
        liffId: 'liff-1',
        richMenuLinkedId: 'richmenu-l',
        richMenuUnlinkedId: 'richmenu-u',
        active: true,
      },
    })
    const taken = await takeLineChannel(before.id)
    expect(taken).toMatchObject({ state: 'TAKEN', channel: { channelKey, channelSecret: 'the-secret', channelAccessToken: 'the-token', richMenuLinkedId: 'richmenu-l' } })
    if (taken.state !== 'TAKEN') throw new Error('not taken')
    // The wipe removes the old row (and its organization); the seed makes the demo organization again with a new id
    await prisma.lineChannelConfig.deleteMany({ where: { organizationId: before.id } })
    const after = await createOrg()
    await putLineChannel(after.id, taken.channel, NOW)
    const row = await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: after.id } })
    expect(row).toMatchObject({ channelKey, providerId: 'provider-1', messagingChannelId: 'messaging-1', liffId: 'liff-1', richMenuLinkedId: 'richmenu-l', richMenuUnlinkedId: 'richmenu-u', active: true })
    expect(openLineSecret(after.id, 'channelSecret', row.channelSecretEnc)).toBe('the-secret')
    expect(openLineSecret(after.id, 'channelAccessToken', row.channelAccessTokenEnc)).toBe('the-token')
    // Sealed for the new organization: the value does not open as the old one's
    expect(openLineSecret(before.id, 'channelSecret', row.channelSecretEnc)).toBeNull()
    // A second put replaces the row the seed may have made from the LINE_* values
    await putLineChannel(after.id, { ...taken.channel, richMenuLinkedId: 'richmenu-l2' }, NOW)
    expect(await prisma.lineChannelConfig.count({ where: { organizationId: after.id } })).toBe(1)
    expect((await prisma.lineChannelConfig.findFirstOrThrow({ where: { organizationId: after.id } })).richMenuLinkedId).toBe('richmenu-l2')
    // Each put records organization.settings_updated, naming the fields and never a value (NFR-SEC-09)
    const events = await prisma.event.findMany({ where: { organizationId: after.id, type: 'organization.settings_updated' }, orderBy: { seq: 'asc' } })
    expect(events.map((e) => e.data)).toEqual([
      { section: 'lineChannel', created: true, changed: ['providerId', 'messagingChannelId', 'channelSecret', 'channelAccessToken', 'liffId', 'active', 'richMenuLinkedId', 'richMenuUnlinkedId'] },
      { section: 'lineChannel', created: false, changed: ['providerId', 'messagingChannelId', 'channelSecret', 'channelAccessToken', 'liffId', 'active', 'richMenuLinkedId', 'richMenuUnlinkedId'] },
    ])
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain('the-secret')
  })

  it('[FR-PLT-007/AC2] tells a channel whose secrets do not open from no channel at all', async () => {
    const org = await createOrg()
    expect(await takeLineChannel(org.id)).toEqual({ state: 'NONE' })
    await prisma.lineChannelConfig.create({
      data: { organizationId: org.id, channelKey: `broken-${randomUUID()}`, providerId: 'p', messagingChannelId: 'm', channelSecretEnc: 'v1.00000000.a.b.c', channelAccessTokenEnc: 'v1.00000000.a.b.c' },
    })
    expect(await takeLineChannel(org.id)).toEqual({ state: 'NOT_OPENED' })
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

  it('[FR-PLT-007/AC2] refuses while another organization exists, then empties append-only and linked tables, restarts identities and keeps the migration record (real Postgres)', async () => {
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
      await db.query(`create table "Organization" (id serial primary key, code text unique not null)`)
      await db.query(`create table "Ledger" (id integer generated always as identity primary key, org integer references "Organization"(id), note text)`)
      // Like the append-only tables (§6.3): rows can never be changed or deleted, but TRUNCATE fires no row trigger
      await db.query(`create function forbid() returns trigger language plpgsql as $$ begin raise exception 'append-only'; end $$`)
      await db.query(`create trigger forbid_mutation before update or delete on "Ledger" for each row execute function forbid()`)
      await db.query(`insert into "Organization" (code) values ('DEMO'), ('ACME')`)
      await db.query(`insert into "Ledger" (org, note) values (1, 'a'), (2, 'b')`)
      await expect(db.query(`delete from "Ledger"`)).rejects.toThrow('append-only')

      // Another organization: nothing is emptied
      await expect(wipeAllData(url, 'DEMO')).rejects.toBeInstanceOf(OtherOrganizationError)
      expect((await db.query(`select count(*)::int as n from "Ledger"`)).rows[0].n).toBe(2)

      await db.query(`truncate "Organization" cascade`)
      const demo = (await db.query<{ id: number }>(`insert into "Organization" (code) values ('DEMO') returning id`)).rows[0]!.id
      await db.query(`insert into "Ledger" (org, note) values ($1, 'c')`, [demo])
      expect(await wipeAllData(url, 'DEMO')).toBe(2)
      for (const table of ['Organization', 'Ledger']) expect((await db.query(`select count(*)::int as n from "${table}"`)).rows[0].n, table).toBe(0)
      expect((await db.query(`select id from "_prisma_migrations"`)).rows).toEqual([{ id: '20261002024508_s1_platform' }])
      expect((await db.query(`insert into "Ledger" (note) values ('fresh') returning id`)).rows[0].id).toBe(1)
    } finally {
      await db.end()
    }
  })
})
