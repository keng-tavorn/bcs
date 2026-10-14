import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { listUsableBudgetLines } from '@/server/queries/budget'
import { budgetGrantsView, createBudgetGrant, createBudgetGrantForDays, revokeBudgetGrant } from '@/server/services/budget/grants'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// FR-BUD-004 (BR-BUD-04): BUDGET_ADMIN grants a department or a member the use of another department's budget line for
// a period (AC1); without a grant the line is neither offered nor accepted (AC2); with one, the budget owner's
// approvers decide (AC3, also in request-budget.test.ts).

const NOW = new Date('2026-10-05T03:00:00Z')
const DAY = '2026-10-05'
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let itLine: string
beforeAll(async () => {
  org = await createDoaOrg()
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
  itLine = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'IT-OPEX-2569' } })).id
})

const usable = async (code: string) => (await listUsableBudgetLines(org.ctxOf(code, NOW), DAY)).map((l) => l.code)

describe('[FR-BUD-004/AC1] BUDGET_ADMIN grants a department or one member, with a start and an end', () => {
  it('grants CON for a period and records it; only BUDGET_ADMIN may, one grantee only, and never the owner', async () => {
    const grant = { budgetLineId: itLine, granteeDepartmentId: org.department.CON!, validFrom: '2026-10-01T00:00:00Z', validTo: '2026-12-31T00:00:00Z' }
    expect(await createBudgetGrant(org.ctxOf('req_con', NOW), grant, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createBudgetGrant(org.ctxOf('fin_officer', NOW), { ...grant, granteeMemberId: org.member.asst_con! }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await createBudgetGrant(org.ctxOf('fin_officer', NOW), { ...grant, granteeDepartmentId: org.department.IT! }, key())).toMatchObject({ ok: false, error: { details: { reason: 'OWN_DEPARTMENT' } } })
    expect(await createBudgetGrant(org.ctxOf('fin_officer', NOW), { ...grant, validTo: '2026-09-30T00:00:00Z' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PERIOD' } } })
    const created = await createBudgetGrant(org.ctxOf('fin_officer', NOW), grant, key())
    expect(created).toMatchObject({ ok: true })
    if (!created.ok) return
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: created.data.grantId } })).toMatchObject({ type: 'budget_grant.created', actorMemberId: org.member.fin_officer })
    expect(await usable('req_con')).toContain('IT-OPEX-2569')
    // Revoked: no longer offered; revoking twice is refused
    expect(await revokeBudgetGrant(org.ctxOf('fin_officer', NOW), { grantId: created.data.grantId }, key())).toMatchObject({ ok: true })
    expect(await revokeBudgetGrant(org.ctxOf('fin_officer', NOW), { grantId: created.data.grantId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await usable('req_con')).not.toContain('IT-OPEX-2569')
  })

  it('a grant to one member covers that member only', async () => {
    await createBudgetGrant(org.ctxOf('fin_officer', NOW), { budgetLineId: itLine, granteeMemberId: org.member.asst_con!, validFrom: '2026-10-01T00:00:00Z' }, key())
    expect(await usable('asst_con')).toContain('IT-OPEX-2569')
    expect(await usable('receiver_con')).not.toContain('IT-OPEX-2569')
  })
})

describe('[FR-BUD-004/AC2] without a grant, another department’s line is neither offered nor accepted', () => {
  it('offers CON its own lines only, and the submit refuses IT’s line', async () => {
    expect(await usable('receiver_con')).toEqual(['CON-OPEX-2569'])
    const draft = await createDraft(org.ctxOf('receiver_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'ไม่มีสิทธิ์', budgetLineId: itLine, lines: [{ description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPrice: '100.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    expect(await submitRequest(org.ctxOf('receiver_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'BUDGET_LINE_NOT_ALLOWED' } } })
  })
})

describe('[FR-BUD-004/AC3] a request on another department’s budget goes to that department’s approvers', () => {
  it('the member granted IT’s line gets the DM of IT as approver', async () => {
    const draft = await createDraft(org.ctxOf('asst_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'อุปกรณ์ไอทีให้หน้างาน', budgetLineId: itLine, lines: [{ description: 'แท็บเล็ต', quantity: '1', uom: 'เครื่อง', unitPrice: '9000.00' }] }, key())
    if (!draft.ok) throw new Error('draft failed')
    expect(await submitRequest(org.ctxOf('asst_con', NOW), { requestId: draft.data.requestId }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.dm_it } })
  })
})

// The grants page (S3-07): a grant is set by whole days in the organization's time zone (Bangkok), and the page lists
// each grant with what it is at the moment — coming, in force, ended or taken back.

const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const rowOf = async (grantId: string, now: Date) => {
  const view = ok(await budgetGrantsView(org.ctxOf('fin_officer', now)))
  const current = view.current.find((g) => g.id === grantId)
  return current ? { list: 'current', ...current } : { list: 'past', ...view.past.find((g) => g.id === grantId)! }
}

describe('[FR-BUD-004/AC1] a grant by whole days: coming, in force, ended, taken back', () => {
  it('runs from 00:00 of the first day to 00:00 after the last, Bangkok time, and the page follows its state', async () => {
    const created = ok(await createBudgetGrantForDays(org.ctxOf('fin_officer', NOW), { budgetLineId: itLine, granteeKind: 'DEPARTMENT', granteeDepartmentId: org.department.PROC!, firstDay: '2026-10-06', lastDay: '2026-10-31' }, key()))
    expect(await prisma.budgetGrant.findUniqueOrThrow({ where: { id: created.grantId } })).toMatchObject({
      validFrom: new Date('2026-10-06T00:00:00+07:00'),
      validTo: new Date('2026-11-01T00:00:00+07:00'),
      granteeDepartmentId: org.department.PROC,
      granteeMemberId: null,
    })
    expect(await rowOf(created.grantId, NOW)).toMatchObject({
      list: 'current',
      state: 'SCHEDULED',
      days: { first: '2026-10-06', last: '2026-10-31' },
      line: { code: 'IT-OPEX-2569', department: { code: 'IT' } },
      grantee: { kind: 'DEPARTMENT', code: 'PROC' },
      grantedBy: { th: 'ผู้ใช้ fin_officer' },
      revokedAt: null,
    })
    expect(await rowOf(created.grantId, new Date('2026-10-31T16:59:59Z'))).toMatchObject({ list: 'current', state: 'ACTIVE' })
    expect(await rowOf(created.grantId, new Date('2026-10-31T17:00:00Z'))).toMatchObject({ list: 'past', state: 'ENDED' })
    ok(await revokeBudgetGrant(org.ctxOf('fin_officer', NOW), { grantId: created.grantId }, key()))
    expect(await rowOf(created.grantId, NOW)).toMatchObject({ list: 'past', state: 'REVOKED', revokedAt: NOW.toISOString() })
  })

  it('grants one member, named with their employee code and department', async () => {
    const created = ok(await createBudgetGrantForDays(org.ctxOf('fin_officer', NOW), { budgetLineId: itLine, granteeKind: 'MEMBER', granteeMemberId: org.member.receiver_con!, firstDay: '2026-10-05', lastDay: '2026-12-31' }, key()))
    expect(await rowOf(created.grantId, NOW)).toMatchObject({ state: 'ACTIVE', grantee: { kind: 'MEMBER', name: { th: 'ผู้ใช้ receiver_con' }, employeeCode: 'receiver_con', department: { th: 'ฝ่ายก่อสร้าง' } } })
    expect(await usable('receiver_con')).toContain('IT-OPEX-2569')
    ok(await revokeBudgetGrant(org.ctxOf('fin_officer', NOW), { grantId: created.grantId }, key()))
    expect(await usable('receiver_con')).not.toContain('IT-OPEX-2569')
  })

  it('refuses a period already over, a last day before the first, a day that is not a date and a missing grantee', async () => {
    const grant = { budgetLineId: itLine, granteeKind: 'DEPARTMENT', granteeDepartmentId: org.department.PROC!, firstDay: '2026-10-06', lastDay: '2026-10-31' }
    const refused = async (input: Partial<typeof grant> & { granteeMemberId?: string }) => createBudgetGrantForDays(org.ctxOf('fin_officer', NOW), { ...grant, ...input }, key())
    expect(await refused({ firstDay: '2026-09-01', lastDay: '2026-10-04' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'lastDay', reason: 'PAST_PERIOD' } } })
    expect(await refused({ lastDay: '2026-10-05' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'lastDay', reason: 'PERIOD' } } })
    expect(await refused({ firstDay: '2026-02-30' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'firstDay' } } })
    expect(await refused({ granteeKind: 'MEMBER' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'granteeMemberId' } } })
    expect(await refused({ granteeDepartmentId: org.department.IT! })).toMatchObject({ ok: false, error: { details: { reason: 'OWN_DEPARTMENT' } } })
  })

  it('only BUDGET_ADMIN sees the grants or grants by days', async () => {
    expect(await budgetGrantsView(org.ctxOf('req_con', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await budgetGrantsView(org.ctxOf('dm_it', NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await createBudgetGrantForDays(org.ctxOf('dm_it', NOW), { budgetLineId: itLine, granteeKind: 'DEPARTMENT', granteeDepartmentId: org.department.CON!, firstDay: '2026-10-06', lastDay: '2026-10-31' }, key())).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    })
  })

  it('refuses a member who may not grant before looking at what they sent (BR-AUTH-01)', async () => {
    const before = await prisma.budgetGrant.count({ where: { organizationId: org.organizationId } })
    // Days that are not dates, a period already over, an unknown grantee: still FORBIDDEN, with nothing about the input
    for (const input of [
      { budgetLineId: itLine, granteeKind: 'DEPARTMENT', granteeDepartmentId: org.department.CON!, firstDay: '2026-02-30', lastDay: 'tomorrow' },
      { budgetLineId: itLine, granteeKind: 'DEPARTMENT', granteeDepartmentId: org.department.CON!, firstDay: '2026-09-01', lastDay: '2026-09-02' },
      { budgetLineId: 'not-a-line', granteeKind: 'SOMEONE', firstDay: '', lastDay: '' },
    ]) {
      const refused = await createBudgetGrantForDays(org.ctxOf('req_con', NOW), input, key())
      expect(refused).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(refused.ok ? {} : (refused.error.details ?? {})).not.toHaveProperty('field')
    }
    expect(await prisma.budgetGrant.count({ where: { organizationId: org.organizationId } })).toBe(before)
  })

  it('only BUDGET_ADMIN takes a grant back: anyone else is refused and the grant stays in force', async () => {
    const created = ok(await createBudgetGrantForDays(org.ctxOf('fin_officer', NOW), { budgetLineId: itLine, granteeKind: 'MEMBER', granteeMemberId: org.member.asst_con!, firstDay: '2026-10-05', lastDay: '2026-10-31' }, key()))
    for (const code of ['req_con', 'dm_it', 'dm_con']) {
      expect(await revokeBudgetGrant(org.ctxOf(code, NOW), { grantId: created.grantId }, key()), code).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.budgetGrant.findUniqueOrThrow({ where: { id: created.grantId } })).toMatchObject({ revokedAt: null })
    expect(await prisma.event.count({ where: { aggregateId: created.grantId, type: 'budget_grant.revoked' } })).toBe(0)
    expect(await usable('asst_con')).toContain('IT-OPEX-2569')
    // Another organization's grant is not there for this BUDGET_ADMIN (tenant isolation)
    const other = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: other.organizationId, memberId: other.member.fin_officer!, role: 'BUDGET_ADMIN', grantedAt: NOW } })
    const otherLine = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: other.organizationId, code: 'IT-OPEX-2569' } })).id
    const foreign = ok(await createBudgetGrantForDays(other.ctxOf('fin_officer', NOW), { budgetLineId: otherLine, granteeKind: 'DEPARTMENT', granteeDepartmentId: other.department.CON!, firstDay: '2026-10-05', lastDay: '2026-10-31' }, key()))
    expect(await revokeBudgetGrant(org.ctxOf('fin_officer', NOW), { grantId: foreign.grantId }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await prisma.budgetGrant.findUniqueOrThrow({ where: { id: foreign.grantId } })).toMatchObject({ revokedAt: null })
    // The BUDGET_ADMIN of this organization still may
    ok(await revokeBudgetGrant(org.ctxOf('fin_officer', NOW), { grantId: created.grantId }, key()))
    expect(await prisma.event.count({ where: { aggregateId: created.grantId, type: 'budget_grant.revoked' } })).toBe(1)
  })

  it('offers the lines a grant can use with their year end, the departments and the active members, and today', async () => {
    const view = ok(await budgetGrantsView(org.ctxOf('fin_officer', NOW)))
    expect(view.today).toBe('2026-10-05')
    expect(view.lines.find((l) => l.code === 'IT-OPEX-2569')).toMatchObject({ departmentId: org.department.IT, department: { th: 'ฝ่ายไอที' }, fiscalYearCode: 'FY2569', fiscalYearEnds: '2026-12-31' })
    expect(view.departments.map((d) => d.code)).toEqual(expect.arrayContaining(['CON', 'IT', 'PROC']))
    expect(view.members.find((m) => m.id === org.member.req_con)).toEqual({ id: org.member.req_con, name: { th: 'ผู้ใช้ req_con', en: null }, employeeCode: 'req_con', department: { th: 'ฝ่ายก่อสร้าง', en: null } })
  })
})
