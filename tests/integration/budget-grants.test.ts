import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { listUsableBudgetLines } from '@/server/queries/budget'
import { createBudgetGrant, revokeBudgetGrant } from '@/server/services/budget/grants'
import { createDraft, submitRequest } from '@/server/services/requests'
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
