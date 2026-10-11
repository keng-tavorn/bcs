// pnpm db:reset (spec §5.4, FR-PLT-007 AC2): wipe the LOCAL database, apply every migration, then seed.
// Refuses unless APP_ENV=local and both database URLs point at this machine; nothing is touched when it refuses.
// (Prisma refuses `migrate reset` when an AI agent runs it, so the schema is dropped with SQL as the migrator.)
// Parallel lanes (spec §16.13 · P1-01): inside a lane's worktree it refuses main's databases, on main it refuses a
// lane's, and the lane's own database is created when missing.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { isLocalHost, postgresHosts } from '../src/lib/env'
import { databaseOf, isLaneDatabase, MAIN_DATABASES } from './lib/lane'

function stop(message: string): never {
  console.error(`db:reset ปฏิเสธ: ${message} — ไม่ได้แตะฐานข้อมูล`)
  process.exit(1)
}

/** True when every entry of a comma-separated host list (unset or empty included) is this machine. */
const allOnThisMachine = (list: string | undefined): boolean => (list ?? '').split(',').every(isLocalHost)

// Messages never repeat a host or a password (NFR-SEC-09).
export function resetRefusal(env: NodeJS.ProcessEnv, where: { inLaneWorktree: boolean } = { inLaneWorktree: false }): string | null {
  if (env.APP_ENV !== 'local') return `ใช้ได้เฉพาะ APP_ENV=local (ตอนนี้ ${env.APP_ENV ?? 'ไม่ได้ตั้ง'})`
  // libpq connects to PGHOSTADDR instead of resolving the host it is given, whatever the connection string says
  if (!allOnThisMachine(env.PGHOSTADDR)) return 'PGHOSTADDR ชี้ไปที่เครื่องอื่น ลบตัวแปรนี้ก่อนรัน'
  for (const name of ['DIRECT_URL', 'DATABASE_URL'] as const) {
    const value = env[name]
    if (!value) return `ไม่มี ${name}`
    // Every host pg would reach, including ?host= and comma lists
    const hosts = postgresHosts(value)
    if (!hosts) return `${name} อ่านไม่ได้`
    if (!hosts.every(isLocalHost)) return `${name} ชี้ไปที่เครื่องอื่นซึ่งไม่ใช่เครื่องนี้`
    // No host at all: pg connects to PGHOST, and to localhost only when PGHOST is unset
    if (hosts.length === 0 && !allOnThisMachine(env.PGHOST)) {
      return `${name} ไม่ได้ระบุ host จึงใช้ PGHOST ซึ่งชี้ไปที่เครื่องอื่น ใส่ localhost ใน ${name} หรือลบ PGHOST ก่อนรัน`
    }
    const database = databaseOf(value)
    if (!database) return `${name} ไม่ได้ระบุชื่อฐานข้อมูล`
    if (where.inLaneWorktree && MAIN_DATABASES.includes(database)) {
      return `${name} ชี้ฐาน ${database} ของ main แต่รันจากในสาย — สร้าง .env ของสายใหม่ด้วย pnpm lane:create <เลขสาย> จาก main`
    }
    if (!where.inLaneWorktree && isLaneDatabase(database)) {
      return `${name} ชี้ฐาน ${database} ของสาย แต่รันจากโฟลเดอร์ main — reset ฐานของสายจากโฟลเดอร์ของสายนั้น`
    }
  }
  return null
}

/** A linked git worktree (a lane, spec §16.13) has a .git file; the main checkout has a .git folder */
export const inLinkedWorktree = (dir: string): boolean => existsSync(path.join(dir, '.git')) && statSync(path.join(dir, '.git')).isFile()

/** Creates the database DIRECT_URL names when it does not exist yet (a new lane's bcs_lN), as global-setup does for tests */
async function ensureDatabase(directUrl: string): Promise<void> {
  const database = databaseOf(directUrl)!
  const maintenance = new URL(directUrl)
  maintenance.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: maintenance.toString() })
  await admin.connect()
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [database])
    if (exists.rowCount === 0) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error(`ชื่อฐาน "${database}" ต้องเป็นตัวพิมพ์เล็ก ตัวเลข หรือ _`)
      await admin.query(`create database "${database}"`)
      await admin.query(`grant connect on database "${database}" to bcs_app`)
      console.log(`db:reset สร้างฐาน ${database}`)
    }
  } finally {
    await admin.end()
  }
}

function run(command: string): void {
  const r = spawnSync(command, { stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

async function main(): Promise<void> {
  const refusal = resetRefusal(process.env, { inLaneWorktree: inLinkedWorktree(process.cwd()) })
  if (refusal) stop(refusal)
  await ensureDatabase(process.env.DIRECT_URL!)
  const client = new pg.Client({ connectionString: process.env.DIRECT_URL })
  await client.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
  run('pnpm exec prisma migrate deploy')
  run('pnpm exec prisma generate')
  run('pnpm exec tsx --env-file-if-exists=.env prisma/seed.ts')
  console.log('db:reset เสร็จ')
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main()
