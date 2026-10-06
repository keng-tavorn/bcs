import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { cancelRequest, createDraft, editRequest, resubmitRequest, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S3-05 (spec §6.4, FR-INT-007 AC1–AC2, FR-BUD-003, BR-BUD-02 to BR-BUD-04): submitting a request checks and reserves
// its budget in the same transaction; a request over budget never reaches an approver; a rejection or a cancellation
// gives the budget back; a return keeps it; a resubmit moves only the difference. Amounts before VAT (BR-BUD-03).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let line: string
let otherLine: string
beforeAll(async () => {
  org = await createDoaOrg()
  // CON gets a line of 500,000 of its own beside the fixture's large one, as in the demo budget
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-CON' } })
  const small = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.CON!, costCenterId: cc.id, code: 'CON-SMALL', nameTh: 'งบเล็ก', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: small.id } })
  line = small.id
  // Fund it through the import path the fixture uses for the others: one more import of 500,000.00
  const { fund } = await import('@/core/budget')
  const { applyBudget } = await import('@/server/budget/ledger')
  const { forTenant } = await import('@/server/db/tenant')
  const { appendEvents } = await import('@/server/events/append')
  const { systemCtx } = await import('@/server/context')
  const ctx = systemCtx(org.organizationId, NOW, 'seed')
  const importId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, ctx, [{ budgetLineId: small.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, 50_000_000n, importId) }])
    if (!r.ok) throw new Error('fund failed')
    await appendEvents(tx, ctx, r.events)
  })
  otherLine = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'IT-OPEX-2569' } })).id
})

const balance = async (budgetLineId = line) => {
  const b = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })
  return { available: b.availableSatang, reserved: b.reservedSatang }
}

/** A request of one line; budgetLineId null leaves the line for the service to choose. Every draft carries the three
 *  quotations ATT-QUOTES asks for above 100,000 baht (BR-FORM-04), so the budget is what decides. */
async function draft(netBaht: string, budgetLineId: string | null = line, priceIncludesVat = false) {
  const r = await createDraft(
    org.ctxOf('req_con', NOW),
    { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat, ...(budgetLineId ? { budgetLineId } : {}), lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: netBaht }] },
    key(),
  )
  if (!r.ok) throw new Error(`draft failed: ${JSON.stringify(r.error)}`)
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({
      data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 1000, status: 'AVAILABLE', uploadedById: org.member.req_con! },
    })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: r.data.requestId, kind: 'QUOTATION' } })
  }
  return r.data.requestId
}

const openTask = (requestId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: requestId } } } })

describe('[FR-INT-007/AC1] submitting reserves the budget in the same transaction, or nothing happens', () => {
  it('reserves 120,000 before VAT, and a request over what is left is refused before any approver', async () => {
    const before = await balance()
    const id = await draft('120000.00')
    const sent = await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect(sent, JSON.stringify(sent.ok ? null : sent.error)).toMatchObject({ ok: true })
    expect(await balance()).toEqual({ available: before.available - 12_000_000n, reserved: before.reserved + 12_000_000n })
    const allocation = await prisma.budgetAllocation.findFirstOrThrow({ where: { budgetLineId: line, sourceType: 'REQUEST_LINE', sourceId: (await prisma.requestLine.findFirstOrThrow({ where: { requestId: id } })).id } })
    expect(allocation.reservedSatang).toBe(12_000_000n)

    // 400,000 on what is left (380,000): refused with what is left and what is missing; no number, route or task
    const over = await draft('400000.00')
    const refused = await submitRequest(org.ctxOf('req_con', NOW), { requestId: over }, key())
    expect(refused).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', details: { available: '380000.00', shortfall: '20000.00' } } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: over } })).toMatchObject({ status: 'DRAFT', number: null })
    expect(await prisma.approvalRoute.count({ where: { subjectId: over } })).toBe(0)
    expect(await balance()).toEqual({ available: before.available - 12_000_000n, reserved: before.reserved + 12_000_000n })
  })

  it('reserves the amount before VAT of a price that includes VAT (BR-BUD-03)', async () => {
    const before = await balance()
    const id = await draft('107000.00', line, true)
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    expect((await balance()).reserved - before.reserved).toBe(10_000_000n)
  })
})

describe('[FR-BUD-003/AC1] [FR-BUD-003/AC2] [FR-INT-007/AC2] no request over budget reaches an approver, whatever the channel', () => {
  it('refuses through the service itself, on every channel', async () => {
    const left = (await balance()).available
    for (const channel of ['WEB', 'LIFF', 'API'] as const) {
      const id = await draft(((left + 1n) / 100n + 1n).toString() + '.00')
      const r = await submitRequest(org.ctxOf('req_con', NOW, channel), { requestId: id }, key())
      expect(r, channel).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
      expect(await prisma.approvalTask.count({ where: { step: { route: { subjectId: id } } } })).toBe(0)
    }
  })
})

describe('[FR-BUD-003/AC3] request.submitted records the budget check', () => {
  it('names the line, what was available and what was reserved', async () => {
    const available = (await balance()).available
    const id = await draft('1000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: id, type: 'request.submitted' } })
    expect(event.data).toMatchObject({ budgetCheck: { budgetLineId: line, availableSatang: available.toString(), reservedSatang: '100000' } })
    expect(await prisma.event.count({ where: { aggregateId: line, type: 'budget.reserved' } })).toBeGreaterThan(0)
  })
})

describe('[FR-INT-009/AC1] rejection and cancellation give the budget back; a return keeps it; a resubmit moves the difference', () => {
  it('a rejection gives back everything', async () => {
    const before = await balance()
    const id = await draft('30000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    await decideTask(org.ctxOf(task.assigneeMemberId === org.member.vp_ops ? 'vp_ops' : 'dm_con', NOW), { taskId: task.id, decision: 'REJECT', reason: 'ไม่จำเป็นต้องซื้อ' }, key())
    expect(await balance()).toEqual(before)
  })

  it('a return keeps the reservation; the resubmit after a smaller edit gives back only the difference', async () => {
    const before = await balance()
    const id = await draft('30000.00')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())
    const task = await openTask(id)
    await decideTask(org.ctxOf('vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'ลดจำนวน' }, key())
    expect((await balance()).reserved - before.reserved).toBe(3_000_000n)
    await editRequest(org.ctxOf('req_con', NOW), { requestId: id, title: 'วัสดุก่อสร้าง (ลดจำนวน)', budgetLineId: line, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: '20000.00' }] }, key())
    // The edit itself moves nothing: the line keeps its id and its reservation until the resubmit
    expect((await balance()).reserved - before.reserved).toBe(3_000_000n)
    expect(await resubmitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true })
    expect((await balance()).reserved - before.reserved).toBe(2_000_000n)
  })

  it('a cancellation gives back everything, and a line removed while returned gives back its share', async () => {
    const before = await balance()
    const r = await createDraft(
      org.ctxOf('req_con', NOW),
      { requestTypeCode: 'BUY_GOODS', title: 'สองบรรทัด', budgetLineId: line, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }, { description: 'ทราย', quantity: '1', uom: 'งาน', unitPrice: '5000.00' }] },
      key(),
    )
    if (!r.ok) throw new Error('draft failed')
    await submitRequest(org.ctxOf('req_con', NOW), { requestId: r.data.requestId }, key())
    const task = await openTask(r.data.requestId)
    await decideTask(org.ctxOf(task.assigneeMemberId === org.member.dm_con ? 'dm_con' : 'vp_ops', NOW), { taskId: task.id, decision: 'RETURN', reason: 'ตัดบรรทัดทราย' }, key())
    await editRequest(org.ctxOf('req_con', NOW), { requestId: r.data.requestId, title: 'บรรทัดเดียว', budgetLineId: line, lines: [{ description: 'ปูน', quantity: '1', uom: 'งาน', unitPrice: '10000.00' }] }, key())
    expect((await balance()).reserved - before.reserved).toBe(1_000_000n)
    expect(await cancelRequest(org.ctxOf('req_con', NOW), { requestId: r.data.requestId, reason: 'ไม่ซื้อแล้ว' }, key())).toMatchObject({ ok: true })
    expect(await balance()).toEqual(before)
  })
})

describe('[FR-BUD-004/AC2] a requester uses a line of another department only with a grant', () => {
  it('refuses IT’s line for a requester of CON without a grant, and needs a line when the department has several', async () => {
    const id = await draft('1000.00', otherLine)
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'BUDGET_LINE_NOT_ALLOWED' } } })
    // CON has two open lines: the request must say which
    const unnamed = await draft('1000.00', null)
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: unnamed }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'budgetLineId', reason: 'CHOOSE_BUDGET_LINE' } } })
  })

  it('with a grant to CON, IT’s line is used and IT’s approvers decide (FR-BUD-004 AC3)', async () => {
    await prisma.budgetGrant.create({ data: { organizationId: org.organizationId, budgetLineId: otherLine, granteeDepartmentId: org.department.CON!, validFrom: new Date('2026-10-01T00:00:00Z'), grantedById: org.member.admin! } })
    const id = await draft('1000.00', otherLine)
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: id }, key())).toMatchObject({ ok: true, data: { assigneeMemberId: org.member.dm_it } })
    expect(await prisma.request.findUniqueOrThrow({ where: { id } })).toMatchObject({ budgetLineId: otherLine, chargedDepartmentId: org.department.IT })
  })
})
