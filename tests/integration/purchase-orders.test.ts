import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow, listPool } from '@/server/services/procurement'
import { cancelPurchaseOrder, editDraftPo, priceHistory, submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-04 (spec §6.4 PO table, FR-P2P-003, FR-P2P-004, FR-P2P-010 AC1, BR-BUD-05, BR-BUD-06): PROCUREMENT edits a draft
// PO, sends it for approval on the DOA rule of PURCHASE_ORDER, and the budget moves as GC-BUD-01 to GC-BUD-04 say,
// here through the real services on one budget line per case. Amounts before VAT (BR-BUD-03).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })

let org: DoaOrg
let supplierId: string
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const proc = () => org.ctxOf('proc_officer', NOW)

beforeAll(async () => {
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
})

/** A budget line of CON funded with `baht` (one case of budget.yaml each) */
async function fundedLine(baht: bigint): Promise<string> {
  const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'FY2569' } })
  const cc = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'CC-CON' } })
  const line = await prisma.budgetLine.create({ data: { organizationId: org.organizationId, fiscalYearId: fy.id, departmentId: org.department.CON!, costCenterId: cc.id, code: `CON-${randomUUID().slice(0, 8)}`, nameTh: 'งบทดสอบ', plannedSatang: 0n } })
  await prisma.budgetLineBalance.create({ data: { organizationId: org.organizationId, budgetLineId: line.id } })
  const ctx = systemCtx(org.organizationId, NOW, 'seed')
  const importId = randomUUID()
  await forTenant(org.organizationId).$transaction(async (tx) => {
    const r = await applyBudget(tx, ctx, [{ budgetLineId: line.id, document: { type: 'IMPORT', id: importId }, run: (s) => fund(s, baht * 100n, importId) }])
    if (!r.ok) throw new Error('fund failed')
    await appendEvents(tx, ctx, r.events)
  })
  return line.id
}

const balance = async (budgetLineId: string) => {
  const b = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })
  const baht = (s: bigint) => `${s / 100n}.${String(s % 100n).padStart(2, '0')}`
  return { available: baht(b.availableSatang), reserved: baht(b.reservedSatang), committed: baht(b.committedSatang), actual: baht(b.actualSatang) }
}

/** Decides every open task of a document with its assignee until none is left */
async function approveAll(subjectId: string, at = NOW) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), at), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** An approved request of one line on `budgetLineId`, with the quotations ATT-QUOTES needs above 100,000 gross */
async function approvedRequest(budgetLineId: string, quantity: string, unitPrice: string, options: { requester?: string; description?: string; categoryCode?: string } = {}) {
  const requester = options.requester ?? 'req_con'
  const draft = ok(
    await createDraft(
      org.ctxOf(requester, NOW),
      { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId, lines: [{ description: options.description ?? 'ปูนซีเมนต์', quantity, uom: 'ถุง', unitPrice, ...(options.categoryCode ? { categoryCode: options.categoryCode } : {}) }] },
      key(),
    ),
  )
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'quote.pdf', mimeType: 'application/pdf', sizeBytes: 1000, status: 'AVAILABLE', uploadedById: org.member[requester]! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf(requester, NOW), { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  const request = await prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, include: { lines: true } })
  expect(request.status).toBe('APPROVED')
  return { id: request.id, lineId: request.lines[0]!.id }
}

/** The draft PO of these request lines (supplier S1, by hand), at a site of their own so no other case's lines join */
async function draftPo(requestLineIds: string[]): Promise<string> {
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ' } })
  await prisma.request.updateMany({ where: { lines: { some: { id: { in: requestLineIds } } } }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(proc(), { requestLineIds, supplierId }, key()))
  const run = ok(await consolidateNow(proc(), key()))
  const mine = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, lines: { some: { sources: { some: { requestLineId: requestLineIds[0]! } } } } } })
  return mine.id
}

const poOf = (id: string) => prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' }, include: { sources: true } } } })

describe('[FR-P2P-004/AC2] the budget moves as GC-BUD-01 to GC-BUD-04 through the services', () => {
  it('GC-BUD-01: a PR reserves, a PR over budget is refused, a cheaper PO holds its amount and gives back the rest', async () => {
    const line = await fundedLine(500_000n)
    const pr1 = await approvedRequest(line, '1', '120000.00')
    expect(await balance(line)).toEqual({ available: '380000.00', reserved: '120000.00', committed: '0.00', actual: '0.00' })
    const pr2 = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'เกินงบ', budgetLineId: line, lines: [{ description: 'เหล็ก', quantity: '1', uom: 'ชุด', unitPrice: '400000.00' }] }, key()))
    for (let i = 0; i < 3; i++) {
      const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
      await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: pr2.requestId, kind: 'QUOTATION' } })
    }
    expect(await submitRequest(org.ctxOf('req_con', NOW), { requestId: pr2.requestId }, key())).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })

    const poId = await draftPo([pr1.lineId])
    const po = await poOf(poId)
    ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: po.lines[0]!.id, unitPrice: '115000.00' }] }, key()))
    ok(await submitPo(proc(), { poId }, key()))
    // need 115,000 ≤ releasable 120,000: nothing moves at submit
    expect(await balance(line)).toEqual({ available: '380000.00', reserved: '120000.00', committed: '0.00', actual: '0.00' })
    await approveAll(poId)
    expect(await balance(line)).toEqual({ available: '385000.00', reserved: '0.00', committed: '115000.00', actual: '0.00' })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('APPROVED')
    expect(await prisma.request.findUniqueOrThrow({ where: { id: pr1.id } })).toMatchObject({ status: 'ORDERED' })
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: pr1.lineId } })).orderedQuantity.toString()).toBe('1')
    // PR-3 reserves 50,000 and gives it back (the request side of GC-BUD-01; actualize is S4-08)
    const pr3 = await approvedRequest(line, '1', '50000.00')
    expect(await balance(line)).toEqual({ available: '335000.00', reserved: '50000.00', committed: '115000.00', actual: '0.00' })
    expect(pr3.id).toBeTruthy()
  })

  it('GC-BUD-02: a PO for part of a request at a higher price reserves the difference at submit, then holds its amount', async () => {
    const line = await fundedLine(100_000n)
    const pr4 = await approvedRequest(line, '10', '1000.00')
    expect(await balance(line)).toEqual({ available: '90000.00', reserved: '10000.00', committed: '0.00', actual: '0.00' })
    const poId = await draftPo([pr4.lineId])
    const po = await poOf(poId)
    ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: po.lines[0]!.id, quantity: '6', unitPrice: '1100.00' }] }, key()))
    expect((await poOf(poId)).lines[0]!.sources[0]).toMatchObject({ releasableSatang: 600_000n })
    ok(await submitPo(proc(), { poId }, key()))
    expect(await balance(line)).toEqual({ available: '89400.00', reserved: '10600.00', committed: '0.00', actual: '0.00' })
    await approveAll(poId)
    expect(await balance(line)).toEqual({ available: '89400.00', reserved: '4000.00', committed: '6600.00', actual: '0.00' })
    // 4 of 10 are left: the request is ordered in part and the rest waits in the pool
    expect(await prisma.request.findUniqueOrThrow({ where: { id: pr4.id } })).toMatchObject({ status: 'PARTIALLY_ORDERED' })
    expect(ok(await listPool(proc())).find((p) => p.requestLineId === pr4.lineId)).toMatchObject({ quantity: '4' })
  })

  it('GC-BUD-03: a rejected PO gives back only the difference it reserved, and its lines return to the pool', async () => {
    const line = await fundedLine(100_000n)
    const pr5 = await approvedRequest(line, '10', '1000.00')
    const poId = await draftPo([pr5.lineId])
    const po = await poOf(poId)
    ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: po.lines[0]!.id, quantity: '6', unitPrice: '1100.00' }] }, key()))
    ok(await submitPo(proc(), { poId }, key()))
    expect(await balance(line)).toEqual({ available: '89400.00', reserved: '10600.00', committed: '0.00', actual: '0.00' })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: poId } } } })
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'REJECT', reason: 'ราคาสูงเกินไป' }, key()))
    expect(await balance(line)).toEqual({ available: '90000.00', reserved: '10000.00', committed: '0.00', actual: '0.00' })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status).toBe('REJECTED')
    expect(ok(await listPool(proc())).find((p) => p.requestLineId === pr5.lineId)).toMatchObject({ quantity: '10' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: poId, type: 'po.rejected' } })).toBeTruthy()
  })

  it('a returned PO goes back to draft with its delta given back and its number kept', async () => {
    const line = await fundedLine(100_000n)
    const pr = await approvedRequest(line, '10', '1000.00')
    const poId = await draftPo([pr.lineId])
    const po = await poOf(poId)
    ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: po.lines[0]!.id, unitPrice: '1100.00' }] }, key()))
    const sent = ok(await submitPo(proc(), { poId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: poId } } } })
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'RETURN', reason: 'แก้ราคา' }, key()))
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).toMatchObject({ status: 'DRAFT', number: sent.number, currentRouteId: null })
    expect(await balance(line)).toEqual({ available: '90000.00', reserved: '10000.00', committed: '0.00', actual: '0.00' })
    const again = ok(await submitPo(proc(), { poId }, key()))
    expect(again.number).toBe(sent.number)
  })
})

describe('[FR-P2P-010/AC1] an approved PO is cancelled with a disposition and a reason (GC-BUD-04)', () => {
  it('RETURN_TO_POOL gives back what it holds and reserves the request line again; the request is back in the pool', async () => {
    const line = await fundedLine(500_000n)
    const pr6 = await approvedRequest(line, '1', '120000.00')
    const poId = await draftPo([pr6.lineId])
    const po = await poOf(poId)
    ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: po.lines[0]!.id, unitPrice: '115000.00' }] }, key()))
    ok(await submitPo(proc(), { poId }, key()))
    await approveAll(poId)
    expect(await balance(line)).toEqual({ available: '385000.00', reserved: '0.00', committed: '115000.00', actual: '0.00' })
    expect(await cancelPurchaseOrder(proc(), { poId, disposition: 'RETURN_TO_POOL', reason: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    ok(await cancelPurchaseOrder(proc(), { poId, disposition: 'RETURN_TO_POOL', reason: 'ผู้ขายไม่มีของ' }, key()))
    expect(await balance(line)).toEqual({ available: '380000.00', reserved: '120000.00', committed: '0.00', actual: '0.00' })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).toMatchObject({ status: 'CANCELLED', cancelDisposition: 'RETURN_TO_POOL', cancelReason: 'ผู้ขายไม่มีของ' })
    expect(await prisma.request.findUniqueOrThrow({ where: { id: pr6.id } })).toMatchObject({ status: 'APPROVED' })
    expect((await prisma.requestLine.findUniqueOrThrow({ where: { id: pr6.lineId } })).orderedQuantity.toString()).toBe('0')
    expect(ok(await listPool(proc())).some((p) => p.requestLineId === pr6.lineId)).toBe(true)
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: poId, type: 'po.cancelled' } })).toMatchObject({ data: { disposition: 'RETURN_TO_POOL', requests: [{ requestId: pr6.id, status: 'APPROVED' }] } })
  })

  it('CANCEL_REQUEST_LINES gives back what it holds and cancels the quantity on the request, which is then completed', async () => {
    const line = await fundedLine(100_000n)
    const pr = await approvedRequest(line, '2', '1000.00')
    const poId = await draftPo([pr.lineId])
    ok(await submitPo(proc(), { poId }, key()))
    await approveAll(poId)
    ok(await cancelPurchaseOrder(proc(), { poId, disposition: 'CANCEL_REQUEST_LINES', reason: 'ไม่ต้องการแล้ว' }, key()))
    expect(await balance(line)).toEqual({ available: '100000.00', reserved: '0.00', committed: '0.00', actual: '0.00' })
    const requestLine = await prisma.requestLine.findUniqueOrThrow({ where: { id: pr.lineId } })
    expect([requestLine.orderedQuantity.toString(), requestLine.cancelledQuantity.toString()]).toEqual(['0', '2'])
    expect(await prisma.request.findUniqueOrThrow({ where: { id: pr.id } })).toMatchObject({ status: 'COMPLETED' })
    expect(await prisma.event.count({ where: { aggregateId: pr.id, type: 'request.completed' } })).toBe(1)
  })

  it('only PROCUREMENT cancels, only an approved or sent PO, never a draft', async () => {
    const line = await fundedLine(100_000n)
    const pr = await approvedRequest(line, '1', '1000.00')
    const poId = await draftPo([pr.lineId])
    expect(await cancelPurchaseOrder(proc(), { poId, disposition: 'RETURN_TO_POOL', reason: 'ยกเลิก' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    ok(await submitPo(proc(), { poId }, key()))
    await approveAll(poId)
    for (const who of ['req_con', 'coo', 'fin_officer']) expect(await cancelPurchaseOrder(org.ctxOf(who, NOW), { poId, disposition: 'RETURN_TO_POOL', reason: 'ยกเลิก' }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-P2P-004/AC1] a PO goes to the approver of the PURCHASE_ORDER rule (GC-DOA-05, GC-DOA-06, GC-DOA-14)', () => {
  const routeOf = async (poId: string) => {
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectId: poId, status: 'ACTIVE' } })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { step: { routeId: route.id }, status: 'OPEN' } })
    return { rule: route.ruleCode, escalatedFrom: route.escalatedFromRuleCode, approver: codeOf(task.assigneeMemberId) }
  }

  it('GC-DOA-05 and GC-DOA-06: up to 1,000,000.00 with VAT goes to the COO, a satang more to the CEO', async () => {
    const line = await fundedLine(3_000_000n)
    const a = await approvedRequest(line, '1', '934579.44')
    const b = await approvedRequest(line, '1', '934579.45')
    const poA = await draftPo([a.lineId])
    ok(await submitPo(proc(), { poId: poA }, key()))
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poA } })).toMatchObject({ grossSatang: 100_000_000n })
    expect(await routeOf(poA)).toEqual({ rule: 'PO-01', escalatedFrom: null, approver: 'coo' })
    const poB = await draftPo([b.lineId])
    ok(await submitPo(proc(), { poId: poB }, key()))
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poB } })).toMatchObject({ grossSatang: 100_000_001n })
    expect(await routeOf(poB)).toEqual({ rule: 'PO-02', escalatedFrom: null, approver: 'ceo' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: poB, type: 'po.submitted' } })).toMatchObject({ data: { doaRuleCode: 'PO-02', grossSatang: '100000001' } })
  })

  it('GC-DOA-14: when the COO requested a source PR, the PO escalates past the COO to the CEO', async () => {
    const line = await fundedLine(1_000_000n)
    await prisma.budgetGrant.create({ data: { organizationId: org.organizationId, budgetLineId: line, granteeMemberId: org.member.coo!, validFrom: new Date('2026-01-01T00:00:00Z'), grantedById: org.member.admin! } })
    const pr = await approvedRequest(line, '1', '5000.00', { requester: 'coo' })
    const poId = await draftPo([pr.lineId])
    ok(await submitPo(proc(), { poId }, key()))
    expect(await routeOf(poId)).toEqual({ rule: 'PO-02', escalatedFrom: 'PO-01', approver: 'ceo' })
  })

  it('[GC-SOD-03] the creator of a PO cannot approve it, even when the task reaches them', async () => {
    const line = await fundedLine(100_000n)
    const pr = await approvedRequest(line, '1', '1000.00')
    const poId = await draftPo([pr.lineId])
    ok(await submitPo(proc(), { poId }, key()))
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).createdById).toBe(org.member.proc_officer)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectId: poId } } } })
    // as if the task had been moved to the creator
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: org.member.proc_officer! } })
    expect(await decideTask(proc(), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-03' } } })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'security.sod_blocked', aggregateId: poId } })).toMatchObject({ data: { rule: 'BR-SOD-03' } })
  })

  it('only PROCUREMENT sends a PO, only a draft, and the approver is told when it is approved', async () => {
    const line = await fundedLine(100_000n)
    const pr = await approvedRequest(line, '1', '1000.00')
    const poId = await draftPo([pr.lineId])
    for (const who of ['req_con', 'coo']) expect(await submitPo(org.ctxOf(who, NOW), { poId }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await submitPo(proc(), { poId }, key()))
    expect(await submitPo(proc(), { poId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    await approveAll(poId)
    expect(await prisma.notification.findFirstOrThrow({ where: { subjectId: poId, templateKey: 'po.approved' } })).toMatchObject({ recipientMemberId: org.member.proc_officer })
  })
})

describe('[FR-P2P-004/AC3] a PO line without a source request line cannot be sent (OQ-24)', () => {
  it('refuses to send it', async () => {
    const line = await fundedLine(100_000n)
    const pr = await approvedRequest(line, '1', '1000.00')
    const poId = await draftPo([pr.lineId])
    // a line slipped in without a source (no service makes one)
    await prisma.poLine.create({ data: { organizationId: org.organizationId, poId, lineNo: 2, description: 'ไม่มีที่มา', quantity: '1', uom: 'ชิ้น', unitPriceSatang: 100n, netSatang: 100n, budgetLineId: line } })
    expect(await submitPo(proc(), { poId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'NO_SOURCE_REQUEST' } } })
  })
})

describe('[FR-P2P-003/AC2] [FR-P2P-003/AC3] PROCUREMENT edits a draft; the totals always come from core', () => {
  it('changes price, quantity up to what is left, terms and notes, removes a line back to the pool, and refuses the rest', async () => {
    const line = await fundedLine(100_000n)
    const a = await approvedRequest(line, '10', '100.00')
    const b = await approvedRequest(line, '5', '20.00', { description: 'ทราย' })
    const poId = await draftPo([a.lineId, b.lineId])
    let po = await poOf(poId)
    expect(po.lines).toHaveLength(2)
    const [la, lb] = po.lines
    // more than the request has → refused with what is left
    expect(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: la!.id, quantity: '11' }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'QUANTITY_OVER_REQUEST', left: '10' } } })
    const edited = ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: la!.id, quantity: '8', unitPrice: '105.50' }], removeLineIds: [lb!.id], paymentTermDays: 30, notesToSupplier: 'ส่งก่อน 10 โมง' }, key()))
    po = await poOf(poId)
    expect(po.lines.map((l) => [l.lineNo, l.quantity.toString(), l.unitPriceSatang, l.netSatang])).toEqual([[1, '8', 10_550n, 84_400n]])
    // 844.00 + VAT 7 % = 59.08 (core, BR-VAT-02)
    expect([po.netSatang, po.vatSatang, po.grossSatang, po.paymentTermDays, po.notesToSupplier, po.version]).toEqual([84_400n, 5_908n, 90_308n, 30, 'ส่งก่อน 10 โมง', edited.version])
    expect(po.lines[0]!.sources[0]).toMatchObject({ requestLineId: a.lineId, releasableSatang: 80_000n })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: poId, type: 'po.updated' } })).toMatchObject({ data: { changed: ['lines.removed', 'lines.quantity', 'lines.unitPrice', 'paymentTermDays', 'notesToSupplier'], lineCount: 1, netSatang: '84400' } })
    // the removed line and the 2 not ordered are back in the pool
    const pool = ok(await listPool(proc()))
    expect(pool.find((p) => p.requestLineId === b.lineId)).toMatchObject({ quantity: '5' })
    expect(pool.find((p) => p.requestLineId === a.lineId)).toMatchObject({ quantity: '2' })
    // a stale version, nothing to change, the last line, totals from the client, and anyone but PROCUREMENT
    expect(await editDraftPo(proc(), { poId, expectedVersion: 0, notesToSupplier: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    expect(await editDraftPo(proc(), { poId, expectedVersion: edited.version, notesToSupplier: 'ส่งก่อน 10 โมง' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    expect(await editDraftPo(proc(), { poId, expectedVersion: edited.version, removeLineIds: [po.lines[0]!.id] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_LINES' } } })
    expect(await editDraftPo(proc(), { poId, expectedVersion: edited.version, grossSatang: '1' } as never, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await editDraftPo(org.ctxOf('req_con', NOW), { poId, expectedVersion: edited.version, notesToSupplier: 'y' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // a PO sent for approval is no longer a draft
    ok(await submitPo(proc(), { poId }, key()))
    expect(await editDraftPo(proc(), { poId, expectedVersion: edited.version + 1, notesToSupplier: 'z' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-P2P-003/AC1] a draft shows the last three prices of the same item and warns above settings.priceAlertPct', () => {
  it('lists earlier approved prices newest first and warns when the new one is more than 10 % above the last', async () => {
    const line = await fundedLine(500_000n)
    for (const [i, price] of ['1000.00', '1050.00'].entries()) {
      const pr = await approvedRequest(line, '1', price, { description: 'สายไฟ  THW 2.5 ', categoryCode: 'ELEC' })
      const poId = await draftPo([pr.lineId])
      ok(await submitPo(proc(), { poId }, key()))
      await approveAll(poId, new Date(NOW.getTime() + (i + 1) * 60_000))
    }
    const pr = await approvedRequest(line, '1', '1200.00', { description: 'สายไฟ thw 2.5', categoryCode: 'ELEC' })
    const poId = await draftPo([pr.lineId])
    const [history] = ok(await priceHistory(proc(), poId))
    expect(history!.previous.map((p) => p.unitPriceSatang)).toEqual([105_000n, 100_000n])
    // 1,200 > 1,050 × 1.10 = 1,155
    expect(history!.alert).toBe(true)
    const po = await poOf(poId)
    ok(await editDraftPo(proc(), { poId, expectedVersion: po.version, lines: [{ poLineId: po.lines[0]!.id, unitPrice: '1155.00' }] }, key()))
    expect(ok(await priceHistory(proc(), poId))[0]!.alert).toBe(false)
    expect(await priceHistory(org.ctxOf('req_con', NOW), poId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
