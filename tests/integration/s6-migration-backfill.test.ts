import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migratorUrl } from '../../scripts/lib/db-urls'
import { TEST_DB, testMigratorUrl } from '../support/test-db'

// S6-01 (docs/sub-specs/S6.md "Entity และ migration"): the S6 migration runs on a database that already has approval
// routes from before S6 (staging). Every step there is a DOA step, so its doaStepNo becomes its step number, and every
// task is slot 1 with no reviewer rule; the CHECK approval_step_kind holds afterwards. The rows are written with the
// tables as they were before the migration, in a database of their own that is dropped at the end.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations')
const S6 = '20261013111315_s6_parallel_approval'
const DB = `${TEST_DB}_s6_backfill`
const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
const sqlOf = (dir: string) => readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8')

let db: pg.Client
const ids = { org: randomUUID(), member: randomUUID(), doa: randomUUID(), route: randomUUID(), step1: randomUUID(), step2: randomUUID(), task1: randomUUID(), task2: randomUUID() }

async function admin<T>(run: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: migratorUrl() })
  await c.connect()
  try {
    return await run(c)
  } finally {
    await c.end()
  }
}

/**
 * Drops the scratch database. An autovacuum worker that just started on it has no role the migrator may signal, so
 * `with (force)` is refused (42501 "permission denied to terminate process") until the worker ends a moment later
 */
async function dropScratch(c: pg.Client) {
  for (let attempt = 1; ; attempt++) {
    try {
      await c.query(`drop database if exists "${DB}" with (force)`)
      return
    } catch (e) {
      if ((e as { code?: string }).code !== '42501' || attempt === 20) throw e
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

beforeAll(async () => {
  await admin(async (c) => {
    await dropScratch(c)
    await c.query(`create database "${DB}"`)
  })
  db = new pg.Client({ connectionString: testMigratorUrl().replace(`/${TEST_DB}`, `/${DB}`) })
  await db.connect()
  expect(dirs).toContain(S6)
  for (const dir of dirs.slice(0, dirs.indexOf(S6))) await db.query(sqlOf(dir))

  // A two-step route of a request as S2 to S5 stored it: no kind, doaStepNo, slotNo or workflowRuleCodes yet
  await db.query(`insert into "Organization" (id, code, "legalNameTh", "taxId", "updatedAt") values ($1, 'BF', 'backfill', '0999999000055', now())`, [ids.org])
  await db.query(`insert into "Member" (id, "organizationId", "displayNameTh", email, "updatedAt") values ($1, $2, 'ผู้อนุมัติ', 'a@bf.local', now())`, [ids.member, ids.org])
  await db.query(
    `insert into "DoaVersion" (id, "organizationId", code, "versionNo", status, "effectiveFrom", "amountBasis", "selfApprovalPolicy", "sodPolicy", "updatedAt")
     values ($1, $2, 'DOA-BF', 1, 'PUBLISHED', '2026-01-01', 'GROSS', 'ESCALATE_NEXT_BAND', '{}', now())`,
    [ids.doa, ids.org],
  )
  await db.query(
    `insert into "ApprovalRoute" (id, "organizationId", "subjectType", "subjectId", "routeNo", "doaVersionId", "ruleCode", "amountBasis", "explanationTh", "updatedAt")
     values ($1, $2, 'REQUEST', $3, 1, $4, 'PR-02', 'GROSS', 'ข้อ PR-02', now())`,
    [ids.route, ids.org, randomUUID(), ids.doa],
  )
  for (const [id, stepNo, status] of [
    [ids.step1, 1, 'DONE'],
    [ids.step2, 2, 'ACTIVE'],
  ] as const) {
    await db.query(`insert into "ApprovalStep" (id, "organizationId", "routeId", "stepNo", "slaBusinessMinutes", status, "updatedAt") values ($1, $2, $3, $4, 480, $5, now())`, [id, ids.org, ids.route, stepNo, status])
  }
  for (const [id, stepId, status] of [
    [ids.task1, ids.step1, 'APPROVED'],
    [ids.task2, ids.step2, 'OPEN'],
  ] as const) {
    await db.query(`insert into "ApprovalTask" (id, "organizationId", "stepId", "assigneeMemberId", "resolvedFrom", status, "assignedAt", "updatedAt") values ($1, $2, $3, $4, 'POSITION:DM@CON', $5, now(), now())`, [
      id,
      ids.org,
      stepId,
      ids.member,
      status,
    ])
  }

  await db.query(sqlOf(S6))
}, 120_000)

afterAll(async () => {
  await db?.end()
  await admin(dropScratch)
})

describe('[FR-WF-102/AC4] [INV-WF-01] the S6 migration keeps every approval of before S6 as it was', () => {
  it('every step before S6 is an APPROVAL step whose doaStepNo is its step number', async () => {
    const steps = await db.query(`select id, "stepNo", "doaStepNo", kind, "reviewGroups" from "ApprovalStep" order by "stepNo"`)
    expect(steps.rows).toEqual([
      { id: ids.step1, stepNo: 1, doaStepNo: 1, kind: 'APPROVAL', reviewGroups: null },
      { id: ids.step2, stepNo: 2, doaStepNo: 2, kind: 'APPROVAL', reviewGroups: null },
    ])
  })

  it('every task before S6 is slot 1 with no reviewer rule', async () => {
    const tasks = await db.query(`select id, "slotNo", "workflowRuleCodes" from "ApprovalTask" order by id`)
    expect(tasks.rows).toHaveLength(2)
    for (const t of tasks.rows) expect(t).toMatchObject({ slotNo: 1, workflowRuleCodes: [] })
  })

  it('the route has no workflow version, and the old columns are untouched', async () => {
    const route = await db.query(`select "workflowVersionId", "ruleCode" from "ApprovalRoute" where id = $1`, [ids.route])
    expect(route.rows[0]).toEqual({ workflowVersionId: null, ruleCode: 'PR-02' })
  })

  it('afterwards an APPROVAL step written without its DOA step number takes its step number', async () => {
    const id = randomUUID()
    await db.query(`insert into "ApprovalStep" (id, "organizationId", "routeId", "stepNo", "slaBusinessMinutes", "updatedAt") values ($1, $2, $3, 3, 480, now())`, [id, ids.org, ids.route])
    const row = await db.query(`select "doaStepNo" from "ApprovalStep" where id = $1`, [id])
    expect(row.rows[0]).toEqual({ doaStepNo: 3 })
  })

  it('a REVIEW step needs its groups and no DOA step number (approval_step_kind)', async () => {
    const insert = (doaStepNo: number | null, groups: string | null) =>
      db.query(`insert into "ApprovalStep" (id, "organizationId", "routeId", "stepNo", "slaBusinessMinutes", kind, "doaStepNo", "reviewGroups", "updatedAt") values ($1, $2, $3, 4, 480, 'REVIEW', $4, $5, now())`, [
        randomUUID(),
        ids.org,
        ids.route,
        doaStepNo,
        groups,
      ])
    await expect(insert(null, null)).rejects.toThrow(/approval_step_kind/)
    await expect(insert(1, '[]')).rejects.toThrow(/approval_step_kind/)
  })
})
