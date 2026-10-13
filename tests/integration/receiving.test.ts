import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { closePurchaseOrder, submitPo } from '@/server/services/purchase-orders'
import { recordInvoice } from '@/server/services/invoices'
import { postGoodsReceipt, requestCloseShort } from '@/server/services/receiving'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S4-07 (spec §6.4 GR, §7.11, BR-GR-01 to BR-GR-05, FR-P2P-006, FR-P2P-007, FR-P2P-010 AC2 AC3): the receiver of the
// requesting department posts what came per PO line; partial receipts move the PO to PARTIALLY_RECEIVED; an excess
// goes back or waits for the GR_VARIANCE approver; within the tolerance it is held at once; a PO that will not come in
// full is closed short once approved, giving back what never came and keeping what was received for its invoice.

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
const receiver = () => org.ctxOf('receiver_con', NOW)

beforeAll(async () => {
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
})

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
  return {
    available: baht(b.availableSatang),
    reserved: baht(b.reservedSatang),
    committed: baht(b.committedSatang),
    actual: baht(b.actualSatang),
    /** The same amounts in satang, as the row holds them: differences are taken here, never through a float (BR-MONEY-01) */
    satang: { available: b.availableSatang, reserved: b.reservedSatang, committed: b.committedSatang, actual: b.actualSatang },
  }
}

async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** A PO of `quantity` × `unitPrice` sent to the supplier (S4-06 sends it by email; here it is marked SENT) */
async function sentPo(quantity: string, unitPrice: string): Promise<{ poId: string; poLineId: string; requestId: string; line: string }> {
  const line = await fundedLine(1_000_000n)
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId: line, lines: [{ description: 'ปูน', quantity, uom: 'ถุง', unitPrice }] }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์' } })
  await prisma.request.update({ where: { id: draft.requestId }, data: { deliverySiteId: site.id } })
  const requestLine = await prisma.requestLine.findFirstOrThrow({ where: { requestId: draft.requestId } })
  ok(await assignSupplier(proc(), { requestLineIds: [requestLine.id], supplierId }, key()))
  const run = ok(await consolidateNow(proc(), key()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: true } })
  ok(await submitPo(proc(), { poId: po.id }, key()))
  await approveAll(po.id)
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
  return { poId: po.id, poLineId: po.lines[0]!.id, requestId: draft.requestId, line }
}

const poStatus = async (poId: string) => (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).status
const lineOf = (poLineId: string) => prisma.poLine.findUniqueOrThrow({ where: { id: poLineId } })

describe('[FR-P2P-006/AC1] [FR-P2P-006/AC2] the receiver posts what came per line; part of an order moves the PO on (GC-GR-01)', () => {
  it('receives 6 of 10, then the other 4, with the delivery note, a GR number each time, and the requester and PROCUREMENT told', async () => {
    const po = await sentPo('10', '1100.00')
    const first = ok(await postGoodsReceipt(receiver(), { poId: po.poId, deliveryNoteNo: 'DN-001', lines: [{ poLineId: po.poLineId, received: '6' }] }, key()))
    expect(first).toMatchObject({ poStatus: 'PARTIALLY_RECEIVED', varianceIds: [] })
    expect(first.number).toMatch(/^GR-\d{4}-\d{5}$/)
    expect(await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: first.grId }, include: { lines: true } })).toMatchObject({ status: 'POSTED', deliveryNoteNo: 'DN-001', receiverMemberId: org.member.receiver_con, lines: [{ poLineId: po.poLineId }] })
    expect((await lineOf(po.poLineId)).receivedQuantity.toString()).toBe('6')
    expect(await prisma.notification.findMany({ where: { subjectId: po.poId, templateKey: 'gr.posted' }, select: { recipientMemberId: true } })).toEqual(
      expect.arrayContaining([{ recipientMemberId: org.member.req_con }, { recipientMemberId: org.member.proc_officer }]),
    )
    const second = ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '4' }] }, key()))
    expect(second.poStatus).toBe('RECEIVED')
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: second.grId, type: 'gr.posted' } })).toMatchObject({ data: { poStatus: 'RECEIVED', lines: [{ received: '4', accepted: '4', rejected: '0' }] } })
  })

  it('takes a photo the receiver uploaded, and needs one for damaged goods (BR-GR-05)', async () => {
    const po = await sentPo('5', '100.00')
    expect(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '5', rejected: '1', damagedDisposition: 'ACCEPT_DAMAGED' }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PHOTO_REQUIRED' } } })
    const photo = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.jpg`, fileName: 'box.jpg', mimeType: 'image/jpeg', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.receiver_con! } })
    const gr = ok(await postGoodsReceipt(receiver(), { poId: po.poId, photoFileIds: [photo.id], lines: [{ poLineId: po.poLineId, received: '5', rejected: '1', damagedDisposition: 'ACCEPT_DAMAGED' }] }, key()))
    expect(await prisma.fileLink.findFirstOrThrow({ where: { subjectType: 'GoodsReceipt', subjectId: gr.grId } })).toMatchObject({ kind: 'PHOTO', fileId: photo.id })
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: gr.varianceIds[0]! } })).toMatchObject({ type: 'DAMAGED', disposition: 'ACCEPT_DAMAGED', status: 'PENDING_APPROVAL', amountSatang: 10_000n })
    expect(gr.poStatus).toBe('PARTIALLY_RECEIVED')
  })
})

describe('[FR-P2P-006/AC3] separation of duties at receiving (GC-SOD-02, GC-SOD-05)', () => {
  it('refuses who approved the PR, lets the requester receive under this DOA, and refuses members without the role', async () => {
    const po = await sentPo('2', '100.00')
    // dm_con approved the request (PR-01)
    expect(await postGoodsReceipt(org.ctxOf('dm_con', NOW), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '1' }] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.dm_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW } })
    expect(await postGoodsReceipt(org.ctxOf('dm_con', NOW), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '1' }] }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-02' } } })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'security.sod_blocked', aggregateId: po.poId } })).toMatchObject({ data: { rule: 'BR-SOD-02' } })
    expect(await postGoodsReceipt(org.ctxOf('fin_officer', NOW), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '1' }] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the requester may receive their own goods (sodPolicy.requesterMayReceive = true)
    expect(ok(await postGoodsReceipt(org.ctxOf('req_con', NOW), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '1' }] }, key())).poStatus).toBe('PARTIALLY_RECEIVED')
  })

  it('refuses goods on a PO that is not sent yet', async () => {
    const po = await sentPo('1', '100.00')
    await prisma.purchaseOrder.update({ where: { id: po.poId }, data: { status: 'APPROVED' } })
    expect(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '1' }] }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-P2P-007/AC1] [FR-P2P-007/AC2] [FR-P2P-007/AC3] an excess goes back or waits for the GR_VARIANCE approver (GC-GR-02, GC-GR-03, GC-DOA-18)', () => {
  it('GC-GR-02: RETURN_EXCESS records the variance and accepts the ordered 10; nothing more is held', async () => {
    const po = await sentPo('10', '1100.00')
    const before = await balance(po.line)
    expect(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '11' }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EXCESS_DISPOSITION_REQUIRED', excess: '1' } } })
    const gr = ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '11', excessDisposition: 'RETURN_EXCESS' }] }, key()))
    expect(gr.poStatus).toBe('RECEIVED')
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: gr.varianceIds[0]! } })).toMatchObject({ type: 'OVER', disposition: 'RETURN_EXCESS', status: 'RECORDED', amountSatang: 110_000n, currentRouteId: null })
    expect((await lineOf(po.poLineId)).receivedQuantity.toString()).toBe('10')
    expect(await balance(po.line)).toEqual(before)
  })

  it('GC-GR-03: ACCEPT_EXCESS goes to the DM of the department (GRV-01); once approved the excess is kept and held, in the ledger', async () => {
    const po = await sentPo('10', '1100.00')
    const before = await balance(po.line)
    const gr = ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '11', excessDisposition: 'ACCEPT_EXCESS' }] }, key()))
    const variance = await prisma.variance.findUniqueOrThrow({ where: { id: gr.varianceIds[0]! } })
    expect(variance).toMatchObject({ status: 'PENDING_APPROVAL', amountSatang: 110_000n })
    const route = await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'VARIANCE', subjectId: variance.id } })
    expect(route.ruleCode).toBe('GRV-01')
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId: route.id } } })
    expect(codeOf(task.assigneeMemberId)).toBe('dm_con')
    // a variance is approved or rejected, not returned
    expect(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'RETURN', reason: 'ตีกลับ' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    ok(await decideTask(org.ctxOf('dm_con', NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await prisma.variance.findUniqueOrThrow({ where: { id: variance.id } })).toMatchObject({ status: 'APPROVED' })
    expect((await lineOf(po.poLineId)).receivedQuantity.toString()).toBe('11')
    const after = await balance(po.line)
    expect(after.satang.committed - before.satang.committed).toBe(110_000n)
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: po.line, type: 'budget.committed', data: { path: ['documentId'], equals: po.poId }, NOT: { data: { path: ['amountSatang'], equals: '1100000' } } } })).toMatchObject({ data: { amountSatang: '110000' } })
  })

  it('GC-GR-05: within the tolerance the excess is accepted at once and held at the PO price', async () => {
    const orgRow = await prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })
    const settings = orgRow.settings as Record<string, unknown>
    await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: { ...settings, receiving: { overTolerancePct: 5 } } } })
    try {
      const po = await sentPo('100', '10.00')
      const before = await balance(po.line)
      const gr = ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '104' }] }, key()))
      expect(gr).toMatchObject({ poStatus: 'RECEIVED', varianceIds: [] })
      expect((await lineOf(po.poLineId)).acceptedExtraQuantity.toString()).toBe('4')
      expect((await balance(po.line)).satang.committed - before.satang.committed).toBe(4_000n)
    } finally {
      await prisma.organization.update({ where: { id: org.organizationId }, data: { settings: settings as object } })
    }
  })
})

describe('[FR-P2P-010/AC2] [FR-P2P-010/AC3] a PO that will not come in full is closed short once approved (GC-GR-04)', () => {
  it('refuses to close while short; CLOSE_SHORT approved gives back what never came, keeps the received part for its invoice and closes the PO', async () => {
    const po = await sentPo('10', '1100.00')
    ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '6' }] }, key()))
    expect(await closePurchaseOrder(proc(), { poId: po.poId }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'SHORT_NOT_APPROVED' } } })
    expect(await requestCloseShort(org.ctxOf('req_con', NOW), { poId: po.poId, reason: 'ผู้ขายเลิกผลิต' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const asked = ok(await requestCloseShort(proc(), { poId: po.poId, reason: 'ผู้ขายเลิกผลิต' }, key()))
    const variance = await prisma.variance.findUniqueOrThrow({ where: { id: asked.varianceIds[0]! } })
    expect(variance).toMatchObject({ type: 'SHORT', disposition: 'CLOSE_SHORT', status: 'PENDING_APPROVAL', amountSatang: 440_000n })
    expect(variance.quantity.toString()).toBe('4')
    expect(await requestCloseShort(proc(), { poId: po.poId, reason: 'ซ้ำ' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CLOSE_SHORT_PENDING' } } })
    const before = await balance(po.line)
    await approveAll(variance.id)
    expect(await poStatus(po.poId)).toBe('CLOSED')
    const after = await balance(po.line)
    // 4 × 1,100 never came: given back; 6 × 1,100 received and not invoiced: still held (ADR-038 ข้อ 10)
    expect(after.satang.available - before.satang.available).toBe(440_000n)
    expect(after.committed).toBe('6600.00')
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: po.poId, type: 'po.closed' } })).toMatchObject({ data: { via: 'CLOSE_SHORT', keptSatang: '660000', releasedSatang: '0' } })
    expect((await lineOf(po.poLineId)).cancelledQuantity.toString()).toBe('4')
    expect(await prisma.request.findUniqueOrThrow({ where: { id: po.requestId } })).toMatchObject({ status: 'COMPLETED' })
  })

  it('a PO received in full closes and keeps what is not invoiced; only PROCUREMENT closes', async () => {
    const po = await sentPo('2', '500.00')
    ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '2' }] }, key()))
    expect(await closePurchaseOrder(org.ctxOf('req_con', NOW), { poId: po.poId }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await closePurchaseOrder(proc(), { poId: po.poId }, key()))
    expect(await poStatus(po.poId)).toBe('CLOSED')
    expect((await balance(po.line)).committed).toBe('1000.00')
  })
})

describe('[FR-P2P-010/AC3] a PO closed after some of its invoices keeps what was received and not invoiced (NEW-11, BR-BUD-06, ADR-038 ข้อ 10)', () => {
  const fin = () => org.ctxOf('fin_officer', NOW)
  const invoice = (poId: string, net: string, vat: string, isFinal = false) =>
    recordInvoice(fin(), { poId, invoiceNo: `INV-${randomUUID().slice(0, 8)}`, invoiceDate: '2026-10-05', net, vat, isFinal }, key())

  it('received in full, one invoice in, then closed: the rest of the received goods stays held; the final invoice gives back what is left', async () => {
    const po = await sentPo('10', '1100.00')
    ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '10' }] }, key()))
    ok(await invoice(po.poId, '4000.00', '280.00'))
    expect(await balance(po.line)).toMatchObject({ committed: '7000.00', actual: '4000.00' })
    ok(await closePurchaseOrder(proc(), { poId: po.poId }, key()))
    expect(await poStatus(po.poId)).toBe('CLOSED')
    // 10 × 1,100 received, 4,000 invoiced: 7,000 received and not invoiced is held for its invoice, nothing is given back
    expect(await balance(po.line)).toMatchObject({ committed: '7000.00', actual: '4000.00' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: po.poId, type: 'po.closed' } })).toMatchObject({ data: { via: 'PROCUREMENT', keptSatang: '700000', releasedSatang: '0' } })
    // The final invoice is recorded on the closed PO and gives back what it does not take
    ok(await invoice(po.poId, '6000.00', '420.00', true))
    expect(await balance(po.line)).toMatchObject({ committed: '0.00', actual: '10000.00' })
  })

  it('one invoice in, then closed short: what never came goes back, the received part not invoiced stays held until the final invoice', async () => {
    const po = await sentPo('10', '1100.00')
    ok(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '6' }] }, key()))
    ok(await invoice(po.poId, '2000.00', '140.00'))
    expect(await balance(po.line)).toMatchObject({ committed: '9000.00', actual: '2000.00' })
    const asked = ok(await requestCloseShort(proc(), { poId: po.poId, reason: 'ผู้ขายเลิกผลิต' }, key()))
    await approveAll(asked.varianceIds[0]!)
    expect(await poStatus(po.poId)).toBe('CLOSED')
    // 4 × 1,100 never came: given back once (BR-GR-04); 6 × 1,100 received less 2,000 invoiced: 4,600 held
    expect(await balance(po.line)).toMatchObject({ committed: '4600.00', actual: '2000.00' })
    expect(await prisma.event.findFirstOrThrow({ where: { aggregateId: po.poId, type: 'po.closed' } })).toMatchObject({ data: { via: 'CLOSE_SHORT', keptSatang: '460000' } })
    ok(await invoice(po.poId, '4000.00', '280.00', true))
    expect(await balance(po.line)).toMatchObject({ committed: '0.00', actual: '6000.00' })
  })
})

describe('[FR-P2P-006/AC1] the optional fields P1-07 lays on gr.post (aiAssist of S13, offline of S17)', () => {
  it('an offline capture is VALIDATION_FAILED until S17 fills offline-input.ts, and nothing is received', async () => {
    const po = await sentPo('3', '100.00')
    expect(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '3' }], offline: {} as never }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await poStatus(po.poId)).toBe('SENT')
  })

  it('values of an AI action are MODULE_DISABLED until S13, and the whole receipt rolls back', async () => {
    const po = await sentPo('3', '100.00')
    const aiAssist = { agentActionId: randomUUID(), confirmedPaths: ['lines.0.received'] }
    expect(await postGoodsReceipt(receiver(), { poId: po.poId, lines: [{ poLineId: po.poLineId, received: '3' }], aiAssist }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await poStatus(po.poId)).toBe('SENT')
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)
  })
})
