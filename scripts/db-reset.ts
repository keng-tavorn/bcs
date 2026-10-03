// pnpm db:reset (spec §5.4, FR-PLT-007 AC2): wipe the LOCAL database, apply every migration, then seed.
// Refuses unless APP_ENV=local and both database URLs point at this machine; nothing is touched when it refuses.
// (Prisma refuses `migrate reset` when an AI agent runs it, so the schema is dropped with SQL as the migrator.)
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import pg from 'pg'
import { isLocalHost, postgresHosts } from '../src/lib/env'

function stop(message: string): never {
  console.error(`db:reset ปฏิเสธ: ${message} — ไม่ได้แตะฐานข้อมูล`)
  process.exit(1)
}

/** True when every entry of a comma-separated host list (unset or empty included) is this machine. */
const allOnThisMachine = (list: string | undefined): boolean => (list ?? '').split(',').every(isLocalHost)

// Messages never repeat a host or a password (NFR-SEC-09).
export function resetRefusal(env: NodeJS.ProcessEnv): string | null {
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
  }
  return null
}

function run(command: string): void {
  const r = spawnSync(command, { stdio: 'inherit', shell: true })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

async function main(): Promise<void> {
  const refusal = resetRefusal(process.env)
  if (refusal) stop(refusal)
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
