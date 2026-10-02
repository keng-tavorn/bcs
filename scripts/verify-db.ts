// Database gates of pnpm verify (spec §15.5 gates 4–5), run against a throw-away database `bcs_verify`.
//   tsx scripts/verify-db.ts schema  → prisma validate · fresh migrate deploy · no drift in either direction ·
//                                     applied migrations unchanged in the dev database
//   tsx scripts/verify-db.ts db      → append-only triggers · bcs_app privileges · money CHECK constraints ·
//                                     a live attempt to UPDATE/DELETE "Event" must fail for both roles
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { appUrl, migratorUrl } from './lib/db-urls'

const ROOT = path.resolve(import.meta.dirname, '..')
const VERIFY_DB = 'bcs_verify'
const APPEND_ONLY = ['Event', 'BudgetLedgerEntry', 'EventSeal'] as const
// Named CHECK constraints of spec §6.3 item 3, keyed by the table that must exist first
const NAMED_CHECKS: Record<string, string[]> = {
  BudgetLedgerEntry: ['ledger_amount_positive', 'ledger_buckets_differ'],
  BudgetLineBalance: ['balance_non_negative'],
  RequestLine: ['request_line_qty'],
}

function prisma(args: string, databaseUrl: string) {
  const r = spawnSync(`pnpm exec prisma ${args}`, {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DIRECT_URL: databaseUrl, FORCE_COLOR: '0' },
  })
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function freshVerifyDatabase(): Promise<void> {
  // Recreate the schema as its owner, then apply every migration exactly as staging/production would.
  await withClient(migratorUrl(VERIFY_DB), async (c) => {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE')
    await c.query('CREATE SCHEMA public')
  })
  const deploy = prisma('migrate deploy', migratorUrl(VERIFY_DB))
  if (deploy.code !== 0) throw new Error(`migrate deploy ล้มบนฐานใหม่:\n${deploy.out}`)
}

function migrationChecksums(): Map<string, string> {
  const dir = path.join(ROOT, 'prisma/migrations')
  const map = new Map<string, string>()
  if (!existsSync(dir)) return map
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name, 'migration.sql')
    if (existsSync(file)) map.set(name, createHash('sha256').update(readFileSync(file)).digest('hex'))
  }
  return map
}

async function schemaGate(): Promise<string> {
  const validate = prisma('validate', migratorUrl(VERIFY_DB))
  if (validate.code !== 0) throw new Error(`prisma validate ไม่ผ่าน:\n${validate.out}`)
  await freshVerifyDatabase()
  for (const dir of ['--from-config-datasource --to-schema prisma/schema.prisma', '--from-schema prisma/schema.prisma --to-config-datasource']) {
    const diff = prisma(`migrate diff ${dir} --exit-code`, migratorUrl(VERIFY_DB))
    if (diff.code === 2) throw new Error(`schema.prisma ไม่ตรงกับ migration (drift):\n${diff.out}`)
    if (diff.code !== 0) throw new Error(`migrate diff ล้ม:\n${diff.out}`)
  }
  // Applied migrations must never be edited (§17.3): compare files with what the dev database recorded.
  const files = migrationChecksums()
  const applied = await withClient(migratorUrl(), async (c) => {
    const exists = await c.query(`select to_regclass('public._prisma_migrations') as t`)
    if (!exists.rows[0]?.t) return []
    const r = await c.query<{ migration_name: string; checksum: string }>(
      'select migration_name, checksum from _prisma_migrations where finished_at is not null and rolled_back_at is null',
    )
    return r.rows
  })
  const edited = applied.filter((m) => files.has(m.migration_name) && files.get(m.migration_name) !== m.checksum)
  if (edited.length) throw new Error(`migration ที่ apply แล้วถูกแก้: ${edited.map((m) => m.migration_name).join(', ')}`)
  const pending = [...files.keys()].filter((name) => !applied.some((m) => m.migration_name === name))
  if (pending.length) throw new Error(`ฐาน dev ยังไม่ได้ apply: ${pending.join(', ')} — รัน pnpm db:migrate`)
  return `prisma validate ผ่าน · ${files.size} migration · ไม่มี drift ทั้งสองทาง · migration ที่ apply แล้วไม่ถูกแก้`
}

async function dbGate(): Promise<string> {
  if (!existsSync(path.join(ROOT, 'prisma/migrations'))) return 'ยังไม่มี migration'
  await freshVerifyDatabase()
  const problems: string[] = []
  const summary = await withClient(migratorUrl(VERIFY_DB), async (c) => {
    const tables = new Set(
      (await c.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema='public'`)).rows.map((r) => r.table_name),
    )
    const appendOnly = APPEND_ONLY.filter((t) => tables.has(t))
    for (const t of appendOnly) {
      const trg = await c.query(
        `select tgname from pg_trigger tr join pg_proc p on p.oid = tr.tgfoid
         where tr.tgrelid = $1::regclass and not tr.tgisinternal and p.proname = 'bcs_forbid_mutation'
           and (tr.tgtype & 2) = 2 and (tr.tgtype & 8) = 8 and (tr.tgtype & 16) = 16`,
        [`"${t}"`],
      )
      if (trg.rowCount === 0) problems.push(`ตาราง ${t} ไม่มี trigger append-only (BEFORE UPDATE OR DELETE → bcs_forbid_mutation)`)
      for (const priv of ['UPDATE', 'DELETE', 'TRUNCATE']) {
        const r = await c.query(`select has_table_privilege('bcs_app', $1, $2) as ok`, [`"${t}"`, priv])
        if (r.rows[0]?.ok) problems.push(`bcs_app มีสิทธิ์ ${priv} บน "${t}"`)
      }
      for (const priv of ['SELECT', 'INSERT']) {
        const r = await c.query(`select has_table_privilege('bcs_app', $1, $2) as ok`, [`"${t}"`, priv])
        if (!r.rows[0]?.ok) problems.push(`bcs_app ไม่มีสิทธิ์ ${priv} บน "${t}"`)
      }
    }
    // Every money column carries a CHECK constraint (§6.1 ADR-018); named §6.3 constraints exist.
    const satang = await c.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema='public' and column_name like '%Satang'`,
    )
    for (const col of satang.rows) {
      const chk = await c.query(
        `select 1 from pg_constraint where conrelid = $1::regclass and contype = 'c' and pg_get_constraintdef(oid) like $2`,
        [`"${col.table_name}"`, `%"${col.column_name}"%`],
      )
      if (chk.rowCount === 0) problems.push(`คอลัมน์เงิน "${col.table_name}"."${col.column_name}" ไม่มี CHECK`)
    }
    for (const [table, names] of Object.entries(NAMED_CHECKS)) {
      if (!tables.has(table)) continue
      for (const name of names) {
        const r = await c.query(`select 1 from pg_constraint where conname = $1`, [name])
        if (r.rowCount === 0) problems.push(`ไม่มี constraint ${name} (§6.3)`)
      }
    }
    // Live check: the trigger blocks even the owner role; bcs_app is refused by privileges.
    if (tables.has('Event')) {
      const id = '00000000-0000-7000-8000-000000000001'
      await c.query(
        `insert into "Event"(id, type, "aggregateType", "aggregateId", "occurredAt", "actorType", channel, "correlationId", "requestId", data, "schemaVersion")
         values ($1, 'verify.probe', 'Verify', $1, now(), 'SYSTEM', 'SYSTEM', $1, 'verify', '{}', 1) on conflict do nothing`,
        [id],
      )
      for (const sql of [`update "Event" set type = 'x' where id = '${id}'`, `delete from "Event" where id = '${id}'`]) {
        try {
          await c.query(sql)
          problems.push(`migrator แก้ "Event" ได้: ${sql.split(' ')[0]}`)
        } catch (e) {
          if ((e as { code?: string }).code !== '23001') problems.push(`trigger ตอบผิดรหัส: ${(e as Error).message}`)
        }
      }
      await withClient(appUrl(VERIFY_DB), async (app) => {
        try {
          await app.query(`update "Event" set type = 'x' where id = '${id}'`)
          problems.push('bcs_app แก้ "Event" ได้')
        } catch (e) {
          if ((e as { code?: string }).code !== '42501') problems.push(`bcs_app ถูกปฏิเสธด้วยรหัสที่ไม่คาด: ${(e as Error).message}`)
        }
      })
    }
    return `${appendOnly.length}/${appendOnly.length} trigger append-only (${appendOnly.join(', ')}) · bcs_app ไม่มีสิทธิ์ UPDATE/DELETE/TRUNCATE · CHECK เงิน ${satang.rowCount} คอลัมน์ · ลองแก้ "Event" แล้วถูกปฏิเสธทั้งสอง role`
  })
  if (problems.length) throw new Error(problems.join('\n'))
  return summary
}

const mode = process.argv[2]
const run = mode === 'schema' ? schemaGate : mode === 'db' ? dbGate : null
if (!run) {
  console.error('usage: tsx scripts/verify-db.ts schema|db')
  process.exit(2)
}
run().then(
  (msg) => console.log(msg),
  (error: unknown) => {
    console.error((error as Error).message)
    process.exit(1)
  },
)
