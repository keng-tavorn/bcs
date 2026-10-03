// Prepares the integration test database once per run: create it if needed, recreate the schema, and apply
// all migrations with `prisma migrate deploy` exactly as staging would (real Postgres, never mocked — ADR-027).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import { migratorUrl } from '../../scripts/lib/db-urls'
import { TEST_DB, testMigratorUrl } from '../support/test-db'

export default async function setup(): Promise<void> {
  const admin = new pg.Client({ connectionString: migratorUrl() })
  await admin.connect()
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [TEST_DB])
    if (exists.rowCount === 0) {
      await admin.query(`create database "${TEST_DB}"`)
      await admin.query(`grant connect on database "${TEST_DB}" to bcs_app`)
    }
  } finally {
    await admin.end()
  }
  const db = new pg.Client({ connectionString: testMigratorUrl() })
  await db.connect()
  try {
    await db.query('drop schema if exists public cascade')
    await db.query('create schema public')
  } finally {
    await db.end()
  }
  const root = path.resolve(import.meta.dirname, '..', '..')
  const deploy = spawnSync('pnpm exec prisma migrate deploy', {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: testMigratorUrl() },
  })
  if (deploy.status !== 0) throw new Error(`migrate deploy failed for ${TEST_DB}:\n${deploy.stdout}${deploy.stderr}`)
}
