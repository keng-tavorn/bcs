// The role the running app connects with, checked where only the deployment sees DATABASE_URL: the Vercel build
// (scripts/check-runtime-role.ts, vercel.json). FR-PLT-006 AC3 (runtime uses the app role, never the migrator), spec §6.3
// and INV-EVT-01 (the app role cannot change or empty an append-only table). docs/runbooks/p0-05-neon-staging.md step 10.
import { APPEND_ONLY } from './db-checks'

export const APP_ROLE = 'bcs_app'

export interface TablePrivileges {
  readonly select: boolean
  readonly insert: boolean
  readonly update: boolean
  readonly delete: boolean
  readonly truncate: boolean
}

export interface RuntimeRoleFacts {
  readonly currentUser: string
  readonly superuser: boolean
  /** Member of neon_superuser (whose pg_write_all_data no REVOKE in a migration can take back) */
  readonly neonSuperuser: boolean
  /** Privileges on each append-only table that exists; tables not made yet are left out */
  readonly tables: Readonly<Record<string, TablePrivileges>>
}

/** Every way the facts break the rules, in Thai for the build log; empty when the runtime role is right */
export function runtimeRoleProblems(facts: RuntimeRoleFacts): string[] {
  const problems: string[] = []
  if (facts.currentUser !== APP_ROLE) {
    problems.push(`แอปเชื่อมต่อด้วย role ${facts.currentUser} ไม่ใช่ ${APP_ROLE}: แก้ชื่อผู้ใช้ใน DATABASE_URL ตาม docs/runbooks/p0-05-neon-staging.md ขั้นที่ 9`)
  }
  if (facts.superuser) problems.push(`role ${facts.currentUser} เป็น superuser`)
  if (facts.neonSuperuser) {
    problems.push(`role ${facts.currentUser} เป็นสมาชิก neon_superuser จึงมีสิทธิ์เขียนทุกตาราง: สร้าง ${APP_ROLE} ด้วย SQL ตาม docs/runbooks/p0-05-neon-staging.md ขั้นที่ 7`)
  }
  for (const table of APPEND_ONLY) {
    const p = facts.tables[table]
    if (!p) continue
    for (const [name, granted] of [['UPDATE', p.update], ['DELETE', p.delete], ['TRUNCATE', p.truncate]] as const) {
      if (granted) problems.push(`role ${facts.currentUser} มีสิทธิ์ ${name} บน "${table}" ซึ่งต้องเพิ่มได้อย่างเดียว (spec §6.3 · INV-EVT-01)`)
    }
    for (const [name, granted] of [['SELECT', p.select], ['INSERT', p.insert]] as const) {
      if (!granted) problems.push(`role ${facts.currentUser} ไม่มีสิทธิ์ ${name} บน "${table}"`)
    }
  }
  return problems
}

/** One line for the build log: role names and yes or no only, never a host or a password (NFR-SEC-09) */
export function runtimeRoleSummary(facts: RuntimeRoleFacts): string {
  const tables = Object.keys(facts.tables)
  return `role ของแอป ${facts.currentUser} · ตรวจสิทธิ์ ${tables.length} ตาราง (${tables.join(', ')})`
}
