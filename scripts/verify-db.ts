// Database gates of pnpm verify (spec §15.5 gates 4–5), run against a throw-away database (`bcs_verify`, or the
// name in BCS_VERIFY_DB so parallel runs do not collide; it is created when missing).
//   tsx scripts/verify-db.ts schema [--strict] → prisma validate · fresh migrate deploy · no drift in either direction ·
//                                     migrations match scripts/migrations.lock.json; lock entries and migration.sql
//                                     committed in HEAD or the merge base never change · applied migrations unchanged
//                                     in the dev database · --strict also needs the lock file committed
//   tsx scripts/verify-db.ts db [--strict]     → append-only triggers (enabled, every row) · bcs_app privileges ·
//                                     a live UPDATE/DELETE on every append-only table must fail for both roles ·
//                                     Event.seq identity and createdAt stamp · same-tenant foreign keys · money CHECKs ·
//                                     §6.3 items 3–5 once their tables exist · DOA lint (BR-DOA-08) once DoaVersion
//                                     exists, over the verify database after migrate deploy and the demo seed
//                                     --strict also requires the tables finish line A needs
//   tsx scripts/verify-db.ts lock              → add new migrations to scripts/migrations.lock.json
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import {
  APPEND_ONLY,
  appendOnlyTriggerProblems,
  eventSeqProblems,
  orgForeignKeyProblems,
  probeValueSql,
  stampTriggerProblems,
  strictTableProblems,
  type ColumnRow,
  type ForeignKeyRow,
  type TriggerRow,
} from './lib/db-checks'
import { appUrl, migratorUrl } from './lib/db-urls'
import { LOCK_FILE, committedState, formatLock, migrationChecksums, migrationLockProblems, nextLock, readLock } from './lib/migration-lock'

const ROOT = path.resolve(import.meta.dirname, '..')
const VERIFY_DB = process.env.BCS_VERIFY_DB ?? 'bcs_verify'
const STRICT = process.argv.includes('--strict')
// Named CHECK constraints of spec §6.3 item 3, keyed by the table that must exist first
const NAMED_CHECKS: Record<string, string[]> = {
  BudgetLedgerEntry: ['ledger_amount_positive', 'ledger_buckets_differ'],
  BudgetLineBalance: ['balance_non_negative'],
  RequestLine: ['request_line_qty'],
}
// S2 adds this module: it lints every seeded and published DOA version with the full BR-DOA-08 rule set
const DOA_LINT_GATE = 'scripts/lib/doa-lint-gate.ts'

const qi = (name: string) => `"${name.replace(/"/g, '""')}"`

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

async function ensureVerifyDatabase(): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(VERIFY_DB)) throw new Error(`BCS_VERIFY_DB "${VERIFY_DB}" ต้องเป็นตัวพิมพ์เล็ก ตัวเลข หรือ _`)
  await withClient(migratorUrl(), async (c) => {
    const found = await c.query('select 1 from pg_database where datname = $1', [VERIFY_DB])
    if (found.rowCount === 0) {
      await c.query(`create database ${qi(VERIFY_DB)}`)
      await c.query(`grant connect on database ${qi(VERIFY_DB)} to bcs_app`)
    }
  })
}

async function freshVerifyDatabase(): Promise<void> {
  // Recreate the schema as its owner, then apply every migration exactly as staging/production would.
  await ensureVerifyDatabase()
  await withClient(migratorUrl(VERIFY_DB), async (c) => {
    await c.query('DROP SCHEMA IF EXISTS public CASCADE')
    await c.query('CREATE SCHEMA public')
  })
  const deploy = prisma('migrate deploy', migratorUrl(VERIFY_DB))
  if (deploy.code !== 0) throw new Error(`migrate deploy ล้มบนฐานใหม่:\n${deploy.out}`)
}

/**
 * The demo seed on the verify database (spec §15.5 item 5: "DOA ทุกฉบับที่ seed"): the DOA lint checks the version that
 * db:seed really publishes. Variables already set in the environment win over .env (node --env-file never overrides).
 */
function seedVerifyDatabase(): void {
  const r = spawnSync('pnpm exec tsx --env-file-if-exists=.env prisma/seed.ts', {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: appUrl(VERIFY_DB), DIRECT_URL: migratorUrl(VERIFY_DB), FORCE_COLOR: '0' },
  })
  if (r.status !== 0) throw new Error(`db:seed ล้มบนฐานตรวจ ${VERIFY_DB}:\n${`${r.stdout ?? ''}${r.stderr ?? ''}`.trim()}`)
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
  // Applied migrations must never be edited or deleted (§17.3): what git has committed (lock entries and the
  // migration.sql files themselves) is the reference, so a reset dev database or a fresh CI database cannot hide an
  // edit. --strict also needs the lock file itself committed.
  const files = migrationChecksums(ROOT)
  const { locks, sql, lockCommitted, notes } = committedState(ROOT)
  const lockProblems = migrationLockProblems({ files, lock: readLock(ROOT), committed: locks, committedSql: sql, strict: STRICT, lockCommitted })
  if (lockProblems.length) throw new Error(lockProblems.join('\n'))
  // The dev database also records what it applied: catch an edit made after `migrate dev` and before the lock.
  const applied = await withClient(migratorUrl(), async (c) => {
    const exists = await c.query(`select to_regclass('public._prisma_migrations') as t`)
    if (!exists.rows[0]?.t) return []
    const r = await c.query<{ migration_name: string; checksum: string }>(
      'select migration_name, checksum from _prisma_migrations where finished_at is not null and rolled_back_at is null',
    )
    return r.rows
  })
  const edited = applied.filter((m) => m.migration_name in files && files[m.migration_name] !== m.checksum)
  if (edited.length) throw new Error(`migration ที่ apply แล้วถูกแก้: ${edited.map((m) => m.migration_name).join(', ')}`)
  const pending = Object.keys(files).filter((name) => !applied.some((m) => m.migration_name === name))
  if (pending.length) throw new Error(`ฐาน dev ยังไม่ได้ apply: ${pending.join(', ')} — รัน pnpm db:migrate`)
  const frozen = new Set(sql.flatMap((s) => Object.keys(s.migrations))).size
  const gitNote = [
    ...notes,
    `${frozen} migration ที่ commit แล้วใน ${sql.map((s) => s.ref).join(', ') || '-'} ไม่ถูกแก้`,
    lockCommitted ? `${LOCK_FILE} ตรงกับที่ commit` : `${LOCK_FILE} ยังไม่ได้ commit (โหมด strict ไม่ผ่าน)`,
  ].join(' · ')
  return `prisma validate ผ่าน · ${Object.keys(files).length} migration · ไม่มี drift ทั้งสองทาง · migration ที่ apply แล้วไม่ถูกแก้หรือลบ · ${gitNote}`
}

async function triggersOf(c: pg.Client, table: string): Promise<TriggerRow[]> {
  const r = await c.query<{ name: string; function_name: string; type: number; enabled: string; has_condition: boolean }>(
    `select tr.tgname as name, p.proname as function_name, tr.tgtype::int as type, tr.tgenabled::text as enabled,
            (tr.tgqual is not null) as has_condition
       from pg_trigger tr join pg_proc p on p.oid = tr.tgfoid
      where tr.tgrelid = $1::regclass and not tr.tgisinternal`,
    [qi(table)],
  )
  return r.rows.map((t) => ({ name: t.name, functionName: t.function_name, type: t.type, enabled: t.enabled, hasCondition: t.has_condition }))
}

async function columnsOf(c: pg.Client, table: string): Promise<ColumnRow[]> {
  const r = await c.query<{
    name: string
    type: string
    not_null: boolean
    has_default: boolean
    identity: string
    generated: string
    enum_label: string | null
  }>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
            a.atthasdef as has_default, a.attidentity::text as identity, a.attgenerated::text as generated,
            (select e.enumlabel from pg_enum e where e.enumtypid = a.atttypid order by e.enumsortorder limit 1) as enum_label
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
    [qi(table)],
  )
  return r.rows.map((x) => ({
    name: x.name,
    type: x.type,
    notNull: x.not_null,
    hasDefault: x.has_default,
    identity: x.identity,
    generated: x.generated,
    enumLabel: x.enum_label,
  }))
}

/**
 * Inserts a probe row into `table` inside the caller's transaction (always rolled back). Foreign keys and CHECKs of
 * the table are dropped and its other triggers disabled first, so any table can be probed without seed data.
 */
async function insertProbeRow(c: pg.Client, table: string, overrides: Record<string, string> = {}, keepTriggers = false): Promise<string> {
  const cons = await c.query<{ conname: string }>(`select conname from pg_constraint where conrelid = $1::regclass and contype in ('f', 'c')`, [qi(table)])
  for (const { conname } of cons.rows) await c.query(`alter table ${qi(table)} drop constraint ${qi(conname)}`)
  if (!keepTriggers) {
    for (const t of await triggersOf(c, table)) {
      if (t.functionName !== 'bcs_forbid_mutation') await c.query(`alter table ${qi(table)} disable trigger ${qi(t.name)}`)
    }
  }
  const names: string[] = []
  const values: string[] = []
  for (const col of await columnsOf(c, table)) {
    const value = overrides[col.name] ?? probeValueSql(col)
    if (value === null) continue
    names.push(qi(col.name))
    values.push(value)
  }
  const sql = names.length ? `insert into ${qi(table)} (${names.join(', ')}) values (${values.join(', ')})` : `insert into ${qi(table)} default values`
  const r = await c.query<{ ctid: string }>(`${sql} returning ctid::text as ctid`)
  return r.rows[0]!.ctid
}

const errorCode = (e: unknown) => (e as { code?: string }).code

/** UPDATE and DELETE of a real row must be refused by the trigger (23001), even for the owner role. */
async function liveAppendOnlyProbe(c: pg.Client, table: string): Promise<string[]> {
  const problems: string[] = []
  await c.query('begin')
  try {
    const ctid = await insertProbeRow(c, table)
    const column = (await columnsOf(c, table)).find((col) => !col.identity && !col.generated)
    if (!column) return [`ตาราง ${table} ไม่มีคอลัมน์ที่ลอง UPDATE ได้`]
    const statements = [
      ['UPDATE', `update ${qi(table)} set ${qi(column.name)} = ${qi(column.name)} where ctid = $1::tid`],
      ['DELETE', `delete from ${qi(table)} where ctid = $1::tid`],
    ] as const
    for (const [op, sql] of statements) {
      await c.query('savepoint probe')
      try {
        await c.query(sql, [ctid])
        problems.push(`migrator ${op} "${table}" ได้ — trigger append-only ไม่ทำงาน`)
      } catch (e) {
        if (errorCode(e) !== '23001') problems.push(`${op} "${table}" ถูกปฏิเสธด้วยรหัสที่ไม่คาด (${errorCode(e)}): ${(e as Error).message}`)
      }
      await c.query('rollback to savepoint probe')
    }
  } catch (e) {
    problems.push(`ลองแก้ "${table}" ไม่ได้: ${(e as Error).message}`)
  } finally {
    await c.query('rollback')
  }
  return problems
}

/** bcs_app is refused UPDATE, DELETE and TRUNCATE by privileges (42501) before any row is touched. */
async function liveAppPrivilegeProbe(table: string, column: string): Promise<string[]> {
  const problems: string[] = []
  await withClient(appUrl(VERIFY_DB), async (app) => {
    const statements = [
      ['UPDATE', `update ${qi(table)} set ${qi(column)} = ${qi(column)} where false`],
      ['DELETE', `delete from ${qi(table)} where false`],
      ['TRUNCATE', `truncate ${qi(table)}`],
    ] as const
    for (const [op, sql] of statements) {
      try {
        await app.query(sql)
        problems.push(`bcs_app ${op} "${table}" ได้`)
      } catch (e) {
        if (errorCode(e) !== '42501') problems.push(`bcs_app ${op} "${table}" ถูกปฏิเสธด้วยรหัสที่ไม่คาด (${errorCode(e)}): ${(e as Error).message}`)
      }
    }
  })
  return problems
}

/** Event.createdAt comes from the database clock even when the insert supplies another value. */
async function liveStampProbe(c: pg.Client): Promise<string[]> {
  await c.query('begin')
  try {
    const ctid = await insertProbeRow(c, 'Event', { createdAt: `'2000-01-01T00:00:00Z'::timestamptz` }, true)
    const r = await c.query<{ stamped: boolean }>(`select "createdAt" = now() as stamped from "Event" where ctid = $1::tid`, [ctid])
    return r.rows[0]?.stamped ? [] : ['"Event"."createdAt" รับค่าที่ส่งมาได้ — trigger ต้องตั้งเป็น now() ทุกครั้ง']
  } catch (e) {
    return [`ลองเพิ่ม "Event" ไม่ได้: ${(e as Error).message}`]
  } finally {
    await c.query('rollback')
  }
}

async function dbGate(): Promise<string> {
  if (!existsSync(path.join(ROOT, 'prisma/migrations'))) return 'ยังไม่มี migration'
  await freshVerifyDatabase()
  seedVerifyDatabase()
  const problems: string[] = []
  const notes: string[] = []
  const summary = await withClient(migratorUrl(VERIFY_DB), async (c) => {
    const tables = new Set(
      (await c.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows.map(
        (r) => r.table_name,
      ),
    )
    if (STRICT) {
      const s = strictTableProblems(tables)
      problems.push(...s.problems)
      notes.push(...s.notes)
    }

    // 1–2) append-only: trigger present, enabled and unconditional; bcs_app may only SELECT and INSERT; live probe
    const appendOnly = APPEND_ONLY.filter((t) => tables.has(t))
    for (const t of appendOnly) {
      problems.push(...appendOnlyTriggerProblems(t, await triggersOf(c, t)))
      // A column-level GRANT UPDATE (col) is invisible to has_table_privilege, so UPDATE checks every column too
      const denied = await c.query<{ upd: boolean; del: boolean; trunc: boolean }>(
        `select has_any_column_privilege('bcs_app', $1, 'UPDATE') as upd, has_table_privilege('bcs_app', $1, 'DELETE') as del,
                has_table_privilege('bcs_app', $1, 'TRUNCATE') as trunc`,
        [qi(t)],
      )
      for (const [priv, granted] of Object.entries({ UPDATE: denied.rows[0]?.upd, DELETE: denied.rows[0]?.del, TRUNCATE: denied.rows[0]?.trunc })) {
        if (granted) problems.push(`bcs_app มีสิทธิ์ ${priv} บน "${t}"`)
      }
      for (const priv of ['SELECT', 'INSERT']) {
        const r = await c.query(`select has_table_privilege('bcs_app', $1, $2) as ok`, [qi(t), priv])
        if (!r.rows[0]?.ok) problems.push(`bcs_app ไม่มีสิทธิ์ ${priv} บน "${t}"`)
      }
      problems.push(...(await liveAppendOnlyProbe(c, t)))
      const column = (await columnsOf(c, t)).find((col) => !col.identity && !col.generated)
      if (column) problems.push(...(await liveAppPrivilegeProbe(t, column.name)))
    }

    // Event: global sequence assigned by the database and createdAt from the database clock (§4.5)
    if (tables.has('Event')) {
      const seq = await c.query<{ identity: string }>(`select attidentity::text as identity from pg_attribute where attrelid = '"Event"'::regclass and attname = 'seq'`)
      problems.push(...eventSeqProblems(seq.rows[0]?.identity))
      problems.push(...stampTriggerProblems(await triggersOf(c, 'Event')))
      problems.push(...(await liveStampProbe(c)))
    }

    // Same-tenant foreign keys (INV-TEN-01 at the database level)
    const orgTables = new Set(
      (await c.query<{ table_name: string }>(`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'organizationId'`)).rows.map(
        (r) => r.table_name,
      ),
    )
    const fks = await c.query<{ name: string; from_table: string; to_table: string; from_columns: string[]; to_columns: string[] }>(
      `select c.conname as name, src.relname as from_table, dst.relname as to_table,
              array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) as from_columns,
              array(select a.attname::text from unnest(c.confkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.o) as to_columns
         from pg_constraint c
         join pg_class src on src.oid = c.conrelid
         join pg_class dst on dst.oid = c.confrelid
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace`,
    )
    const fkRows: ForeignKeyRow[] = fks.rows.map((f) => ({ name: f.name, fromTable: f.from_table, toTable: f.to_table, fromColumns: f.from_columns, toColumns: f.to_columns }))
    problems.push(...orgForeignKeyProblems(fkRows, orgTables))

    // 3) every money column carries a CHECK constraint (§6.1 ADR-018); named §6.3 constraints exist on their table
    const satang = await c.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name like '%Satang'`,
    )
    for (const col of satang.rows) {
      const chk = await c.query(
        `select 1 from pg_constraint where conrelid = $1::regclass and contype = 'c' and pg_get_constraintdef(oid) like $2`,
        [qi(col.table_name), `%"${col.column_name}"%`],
      )
      if (chk.rowCount === 0) problems.push(`คอลัมน์เงิน "${col.table_name}"."${col.column_name}" ไม่มี CHECK`)
    }
    for (const [table, names] of Object.entries(NAMED_CHECKS)) {
      if (!tables.has(table)) continue
      for (const name of names) {
        const r = await c.query(`select 1 from pg_constraint where conname = $1 and conrelid = $2::regclass and contype = 'c'`, [name, qi(table)])
        if (r.rowCount === 0) problems.push(`ไม่มี CHECK ${name} บน "${table}" (§6.3)`)
      }
    }

    // 4) one current holder per (position, department)
    if (tables.has('PositionAssignment')) {
      const r = await c.query<{ unique: boolean; columns: string[]; predicate: string | null }>(
        `select i.indisunique as unique,
                array(select a.attname::text from unnest(i.indkey) with ordinality k(n, o)
                        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.n order by k.o) as columns,
                pg_get_expr(i.indpred, i.indrelid) as predicate
           from pg_index i join pg_class ic on ic.oid = i.indexrelid
          where ic.relname = 'position_single_holder' and i.indrelid = '"PositionAssignment"'::regclass`,
      )
      const idx = r.rows[0]
      if (!idx) problems.push('ไม่มี unique index position_single_holder บน "PositionAssignment" (§6.3 ข้อ 4)')
      else if (!idx.unique || idx.columns.join(',') !== 'positionId,departmentId' || !/"validTo" IS NULL/i.test(idx.predicate ?? '')) {
        problems.push('position_single_holder ต้องเป็น UNIQUE ("positionId", "departmentId") WHERE "validTo" IS NULL (§6.3 ข้อ 4)')
      }
    }

    // 5) published DOA versions never overlap in time; and BR-DOA-08 lint over every seeded and published version
    if (tables.has('DoaVersion')) {
      const x = await c.query(`select 1 from pg_constraint where conname = 'doa_no_overlap' and conrelid = '"DoaVersion"'::regclass and contype = 'x'`)
      if (x.rowCount === 0) problems.push('ไม่มี EXCLUDE constraint doa_no_overlap บน "DoaVersion" (§6.3 ข้อ 5)')
      const ext = await c.query(`select 1 from pg_extension where extname = 'btree_gist'`)
      if (ext.rowCount === 0) problems.push('ไม่มี extension btree_gist ที่ doa_no_overlap ต้องใช้ (§6.3 ข้อ 5)')
      const gate = path.join(ROOT, DOA_LINT_GATE)
      if (!existsSync(gate)) {
        problems.push(`ตาราง "DoaVersion" มีแล้วแต่ยังไม่มี ${DOA_LINT_GATE} ที่ lint DOA ทุกฉบับที่ seed หรือเผยแพร่ด้วยกฎ BR-DOA-08 ชุดเต็ม (§15.5 ข้อ 5)`)
      } else {
        const mod = (await import(pathToFileURL(gate).href)) as {
          lintSeededAndPublishedDoa?: (opts: { verifyDatabaseUrl: string }) => Promise<{ checked: number; problems: string[] }>
        }
        if (typeof mod.lintSeededAndPublishedDoa !== 'function') problems.push(`${DOA_LINT_GATE} ต้อง export lintSeededAndPublishedDoa()`)
        else {
          const lint = await mod.lintSeededAndPublishedDoa({ verifyDatabaseUrl: migratorUrl(VERIFY_DB) })
          problems.push(...lint.problems)
          if (lint.checked === 0 && STRICT) problems.push('DOA lint ไม่ได้ตรวจฉบับใดเลย (โหมด strict ต้องตรวจ DOA ที่ seed)')
          notes.push(`DOA lint ${lint.checked} ฉบับ`)
        }
      }
    }

    const missing = APPEND_ONLY.filter((t) => !tables.has(t))
    return [
      `trigger append-only ${appendOnly.length}/${APPEND_ONLY.length} ตาราง (${appendOnly.join(', ')}${missing.length ? ` · ยังไม่มี ${missing.join(', ')}` : ''}) ลองแก้จริงแล้วถูกปฏิเสธทั้งสอง role`,
      `bcs_app ไม่มีสิทธิ์ UPDATE/DELETE/TRUNCATE`,
      `FK ข้าม tenant 0 จาก ${fkRows.length}`,
      `CHECK เงิน ${satang.rowCount} คอลัมน์`,
      ...notes,
    ].join(' · ')
  })
  if (problems.length) throw new Error(problems.join('\n'))
  return summary
}

async function lockCommand(): Promise<string> {
  const files = migrationChecksums(ROOT)
  const { locks, sql } = committedState(ROOT)
  const { lock, problems } = nextLock({ files, lock: readLock(ROOT), committed: locks, committedSql: sql })
  if (problems.length) throw new Error(`${problems.join('\n')}\nไม่ได้แก้ ${LOCK_FILE}`)
  writeFileSync(path.join(ROOT, LOCK_FILE), formatLock(lock))
  return `${LOCK_FILE}: ${Object.keys(lock).length} migration`
}

const mode = process.argv[2]
const run = mode === 'schema' ? schemaGate : mode === 'db' ? dbGate : mode === 'lock' ? lockCommand : null
if (!run) {
  console.error('usage: tsx scripts/verify-db.ts schema|db [--strict] | lock')
  process.exit(2)
}
run().then(
  (msg) => console.log(msg),
  (error: unknown) => {
    console.error((error as Error).message)
    process.exit(1)
  },
)
