import { describe, expect, it } from 'vitest'
import { runtimeRoleProblems, runtimeRoleSummary, type RuntimeRoleFacts, type TablePrivileges } from '../../scripts/lib/runtime-role'

// The rules the Vercel build applies to the role the app connects with (scripts/check-runtime-role.ts). The live check
// against a real database: `APP_ENV=staging pnpm db:check-role` passes as bcs_app and stops as bcs_migrator.

const appendOnly: TablePrivileges = { select: true, insert: true, update: false, delete: false, truncate: false }
const right: RuntimeRoleFacts = { currentUser: 'bcs_app', superuser: false, neonSuperuser: false, tables: { Event: appendOnly, BudgetLedgerEntry: appendOnly } }

describe('the role the app runs as on a deployment (FR-PLT-006 AC3, spec §6.3)', () => {
  it('[FR-PLT-006/AC3] passes bcs_app that may only read and add to the append-only tables', () => {
    expect(runtimeRoleProblems(right)).toEqual([])
    expect(runtimeRoleSummary(right)).toBe('role ของแอป bcs_app · ตรวจสิทธิ์ 2 ตาราง (Event, BudgetLedgerEntry)')
  })

  it('[FR-PLT-006/AC3] stops a build whose app connects as the migrator or another role', () => {
    const problems = runtimeRoleProblems({ ...right, currentUser: 'bcs_migrator' })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('bcs_migrator ไม่ใช่ bcs_app')
  })

  it('[FR-PLT-006/AC3] stops a superuser or a member of neon_superuser even when the name is right', () => {
    expect(runtimeRoleProblems({ ...right, superuser: true })).toEqual(['role bcs_app เป็น superuser'])
    expect(runtimeRoleProblems({ ...right, neonSuperuser: true })[0]).toContain('neon_superuser')
  })

  it('[FR-PLT-006/AC3] stops any UPDATE, DELETE or TRUNCATE on an append-only table, and a missing SELECT or INSERT', () => {
    for (const grant of ['update', 'delete', 'truncate'] as const) {
      const problems = runtimeRoleProblems({ ...right, tables: { ...right.tables, Event: { ...appendOnly, [grant]: true } } })
      expect(problems, grant).toEqual([`role bcs_app มีสิทธิ์ ${grant.toUpperCase()} บน "Event" ซึ่งต้องเพิ่มได้อย่างเดียว (spec §6.3 · INV-EVT-01)`])
    }
    for (const grant of ['select', 'insert'] as const) {
      expect(runtimeRoleProblems({ ...right, tables: { ...right.tables, BudgetLedgerEntry: { ...appendOnly, [grant]: false } } }), grant).toEqual([
        `role bcs_app ไม่มีสิทธิ์ ${grant.toUpperCase()} บน "BudgetLedgerEntry"`,
      ])
    }
  })

  it('[FR-PLT-006/AC3] leaves out only the append-only table no migration has made yet (EventSeal); any other missing table stops it', () => {
    expect(runtimeRoleProblems(right)).toEqual([])
    expect(runtimeRoleProblems({ ...right, tables: { Event: appendOnly } })).toEqual(['role bcs_app ไม่เห็นตาราง "BudgetLedgerEntry": migration ยังไม่ครบ หรือ role ไม่เห็น schema public'])
    expect(runtimeRoleProblems({ ...right, tables: {} })).toHaveLength(2)
  })
})
