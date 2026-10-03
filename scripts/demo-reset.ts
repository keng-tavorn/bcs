// pnpm demo:reset (spec D-07): put the demo back to its state before the demo, in one command — wipe the database,
// apply every migration, check the input workbook, then seed the demo organization with its history (D-01).
//   on this machine (APP_ENV=local):  pnpm demo:reset            — the same as pnpm db:reset
//   on staging (APP_ENV=staging):     pnpm demo:reset --env=<file> --confirm=<org code>-<YYYY-MM-DD>
// Staging data is wiped only when the person types the organization code and today's date (Thai time) — a deliberate
// act; production is always refused. Run against staging only by the person who owns it (CLAUDE.md: wiping staging
// needs their approval each time). Messages never repeat a host or a password (NFR-SEC-09).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { config } from 'dotenv'
import pg from 'pg'
import { resetRefusal } from './db-reset'

function stop(message: string): never {
  console.error(`demo:reset ปฏิเสธ: ${message} — ไม่ได้แตะฐานข้อมูล`)
  process.exit(1)
}

/** Today's date in Thai time, as the confirmation spells it */
export function thaiToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Why this reset may not run, or null. The staging confirmation must name the demo organization and today. */
export function demoResetRefusal(env: NodeJS.ProcessEnv, confirm: string | undefined, orgCode: string, now: Date): string | null {
  if (env.APP_ENV === 'local') return resetRefusal(env)
  if (env.APP_ENV !== 'staging') return `ใช้ได้เฉพาะ APP_ENV=local หรือ staging (ตอนนี้ ${env.APP_ENV ?? 'ไม่ได้ตั้ง'}) · production ไม่มีวันล้างด้วยคำสั่งนี้`
  if (!env.DIRECT_URL || !env.DATABASE_URL) return 'ไม่มี DIRECT_URL หรือ DATABASE_URL ของ staging'
  const expected = `${orgCode}-${thaiToday(now)}`
  if (confirm !== expected) return `การล้าง staging ต้องยืนยันด้วย --confirm=${expected} (รหัสองค์กรตัวอย่างและวันที่วันนี้) ข้อมูลบน staging จะถูกลบทั้งหมดแล้วสร้างใหม่จากไฟล์ inputs`
  return null
}

function run(command: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync(command, { stdio: 'inherit', shell: true, env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  const envFile = arg('env')
  config({ path: envFile ?? '.env', quiet: true, override: Boolean(envFile) })
  // The demo organization's code comes from the input workbook the seed reads, never from code (NG-12)
  const { loadInputWorkbook } = await import('../src/server/seed/workbook')
  const orgCode = (await loadInputWorkbook()).keyValues('Org').get('code')?.value ?? ''
  if (!orgCode) stop('อ่านรหัสองค์กรจากชีต Org ของไฟล์ inputs ไม่ได้')
  const refusal = demoResetRefusal(process.env, arg('confirm'), orgCode, new Date())
  if (refusal) stop(refusal)

  // The workbook must pass its checks before anything is wiped (D-07)
  run('node scripts/py.mjs scripts/validate_inputs.py docs/inputs/BCS_inputs_v1_demo.xlsx --spec spec.md', process.env)
  const client = new pg.Client({ connectionString: process.env.DIRECT_URL })
  await client.connect()
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
  run('pnpm exec prisma migrate deploy', process.env)
  run('pnpm exec prisma generate', process.env)
  run('pnpm exec tsx prisma/seed.ts', process.env)
  console.log(`demo:reset เสร็จ: องค์กร ${orgCode} กลับเป็นสถานะก่อน demo (${process.env.APP_ENV})`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main()
