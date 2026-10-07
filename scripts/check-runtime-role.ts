// pnpm db:check-role — part of the Vercel build (vercel.json buildCommand, after pnpm db:migrate): connects with
// DATABASE_URL as the running app does and stops the build unless that role is bcs_app and cannot change the
// append-only tables (FR-PLT-006 AC3, spec §6.3, INV-EVT-01; rules in scripts/lib/runtime-role.ts). DATABASE_URL is a
// Secret only the deployment sees, so this is where staging is checked (docs/runbooks/p0-05-neon-staging.md step 10).
// APP_ENV=local (or unset): skipped, pnpm verify checks the local databases (scripts/verify-db.ts).
import { config } from 'dotenv'
import pg from 'pg'
import { APPEND_ONLY } from './lib/db-checks'
import { runtimeRoleProblems, runtimeRoleSummary, type RuntimeRoleFacts, type TablePrivileges } from './lib/runtime-role'

config({ path: '.env', quiet: true })

if ((process.env.APP_ENV ?? 'local') === 'local') {
  console.log('db:check-role ข้าม: APP_ENV=local (pnpm verify ตรวจฐานข้อมูลบนเครื่องแล้ว)')
  process.exit(0)
}
if (!process.env.DATABASE_URL) {
  console.error('db:check-role หยุด: ไม่มี DATABASE_URL')
  process.exit(1)
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
try {
  await client.connect()
  const who = await client.query<{ current_user: string; superuser: boolean; neon_superuser: boolean }>(
    `select current_user,
            (select rolsuper from pg_roles where rolname = current_user) as superuser,
            coalesce((select pg_has_role(current_user, oid, 'MEMBER') from pg_roles where rolname = 'neon_superuser'), false) as neon_superuser`,
  )
  const tables: Record<string, TablePrivileges> = {}
  for (const table of APPEND_ONLY) {
    const r = await client.query<{ exists: boolean; sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }>(
      `select to_regclass($1) is not null as exists,
              case when to_regclass($1) is null then false else has_table_privilege(current_user, $1, 'SELECT') end as sel,
              case when to_regclass($1) is null then false else has_table_privilege(current_user, $1, 'INSERT') end as ins,
              case when to_regclass($1) is null then false else has_any_column_privilege(current_user, $1, 'UPDATE') end as upd,
              case when to_regclass($1) is null then false else has_table_privilege(current_user, $1, 'DELETE') end as del,
              case when to_regclass($1) is null then false else has_table_privilege(current_user, $1, 'TRUNCATE') end as trunc`,
      [`"${table}"`],
    )
    const row = r.rows[0]
    if (row?.exists) tables[table] = { select: row.sel, insert: row.ins, update: row.upd, delete: row.del, truncate: row.trunc }
  }
  const facts: RuntimeRoleFacts = {
    currentUser: who.rows[0]?.current_user ?? '',
    superuser: who.rows[0]?.superuser ?? false,
    neonSuperuser: who.rows[0]?.neon_superuser ?? false,
    tables,
  }
  const problems = runtimeRoleProblems(facts)
  if (problems.length > 0) {
    console.error(`db:check-role หยุด build (APP_ENV=${process.env.APP_ENV}): ${runtimeRoleSummary(facts)}`)
    console.error(problems.map((p) => `- ${p}`).join('\n'))
    process.exitCode = 1
  } else {
    console.log(`db:check-role ผ่าน (APP_ENV=${process.env.APP_ENV}): ${runtimeRoleSummary(facts)} · ไม่มีสิทธิ์ UPDATE DELETE TRUNCATE`)
  }
} catch (error) {
  // Only the error code: a pg message can name the host (NFR-SEC-09)
  const code = (error as { code?: unknown } | null)?.code
  console.error(`db:check-role หยุด: ตรวจ role ด้วย DATABASE_URL ไม่ได้ (${typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error'})`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => undefined)
}
