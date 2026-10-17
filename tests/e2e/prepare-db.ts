import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { E2E_DB, E2E_DEMO, E2E_P1DEMO, e2eEnv, withDatabase } from '../support/e2e-env'

// Fresh e2e database before every run: drop the schema, apply all migrations, seed the demo organization.
// Runs as the first step of the e2e web server command (playwright.config.ts) so the server never starts
// against a half-built database. Reads DATABASE_URL/DIRECT_URL from .env (via tsx --env-file).
async function prepareE2eDatabase(): Promise<void> {
  // The screens' e2e database has no demo history (D-01): their tests count tasks, notifications and budget themselves.
  // The demo scenes' database (E2E_DEMO) has the history and nothing else, so the board, dashboard and KPI show the
  // figures of the Demo_History sheet as on the day. Both read the demo workbook, whatever SEED_INPUTS .env holds (P1-02).
  // The scenes of phase 1 (E2E_P1DEMO, P1-08) read the phase-1 workbook: organization SIMEC with its Request_History.
  const scenes = E2E_DEMO || E2E_P1DEMO
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...e2eEnv(),
    SEED_DEMO_HISTORY: process.env.SEED_DEMO_HISTORY ?? (scenes ? '1' : '0'),
    SEED_INPUTS: E2E_P1DEMO ? 'p1' : 'demo',
  }
  const admin = new pg.Client({ connectionString: withDatabase(process.env.DIRECT_URL!, 'postgres') })
  await admin.connect()
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [E2E_DB])
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${E2E_DB}"`)
  } finally {
    await admin.end()
  }
  const db = new pg.Client({ connectionString: env.DIRECT_URL })
  await db.connect()
  try {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE')
    await db.query('CREATE SCHEMA public')
  } finally {
    await db.end()
  }
  // storage-init: the private bucket and its CORS rule for the e2e origin (browser uploads, FR-PLT-004)
  // seed-platform-admin: a BCS-team account for the /platform pages (the demo seed has none)
  // seed-activity: requests submitted through the services, so approvers have tasks and notifications
  const commands = scenes
    ?['pnpm exec prisma migrate deploy', 'pnpm exec tsx scripts/storage-init.ts', 'pnpm exec tsx prisma/seed.ts']
    : ['pnpm exec prisma migrate deploy', 'pnpm exec tsx prisma/seed.ts', 'pnpm exec tsx tests/e2e/seed-platform-admin.ts', 'pnpm exec tsx tests/e2e/seed-activity.ts', 'pnpm exec tsx scripts/storage-init.ts']
  for (const command of commands) {
    const r = spawnSync(command, { shell: true, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`${command} failed:\n${r.stdout}\n${r.stderr}`)
  }
}

await prepareE2eDatabase()
console.log('e2e database ready')
