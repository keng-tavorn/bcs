import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { businessDaysOf, getMyOpenTaskId, getRouteStepDetails, listPoInvoices, listPoReceipts, listRequestPurchaseOrders } from '@/server/queries/document-page'
import { getRequestView } from '@/server/queries/requests'
import { decideTask, requestInfo } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { createDraft, submitRequest } from '../support/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// S16-07: the read side of the tabbed document page (FR-INT-012, src/server/queries/document-page.ts) on an organization
// built from the §7.4 fixtures: each route step's SLA, the channel of its decision and its own history for the step cards
// and their panel (AC3), the open task the reader holds for the decision bar (AC4), the POs of a request for its tab
// (AC2, AC6) and the business days a document has taken (AC1). Monday 5 Oct 2026 10:00 Thai time; business hours
// Mon–Fri 08:30–17:30, 8 business hours to decide (BR-SLA-01).

const NOW = new Date('2026-10-05T03:00:00Z')
const MON_1300 = new Date('2026-10-05T06:00:00Z')
const MON_1500 = new Date('2026-10-05T08:00:00Z')
const TUE_1000 = new Date('2026-10-06T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

let org: DoaOrg
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
})

async function submitted(requester: string, grossBaht: string) {
  const draft = ok(
    await createDraft(
      org.ctxOf(requester, NOW),
      { requestTypeCode: 'BUY_GOODS', title: 'วัสดุก่อสร้าง', priceIncludesVat: true, lines: [{ description: 'ปูนซีเมนต์', quantity: '1', uom: 'งาน', unitPrice: grossBaht }] },
      key(),
    ),
  )
  ok(await submitRequest(org.ctxOf(requester, NOW), { requestId: draft.requestId }, key()))
  const view = await getRequestView(org.ctxOf(requester, NOW), draft.requestId)
  return { requestId: draft.requestId, routeId: view!.route!.id }
}

const openTask = (subjectId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] }, step: { route: { subjectId } } } })

describe('[FR-INT-012/AC3] a step card shows its SLA used of the time it has, and its panel the history of its task', () => {
  it('counts 3 of 8 business hours at 13:00, and past its due time the next morning', async () => {
    const { routeId } = await submitted('req_con', '45000.00')
    const [step] = await getRouteStepDetails(org.ctxOf('req_con', MON_1300), routeId)
    // Due Tuesday 09:00: 8 business hours from Monday 10:00; 13:00 used 180 minutes of 480
    expect(step).toMatchObject({ stepNo: 1, channel: null, sla: { usedMinutes: 180, targetMinutes: 480, overdue: false, dueAt: new Date('2026-10-06T02:00:00Z') } })
    expect(step!.history.map((h) => [h.what, h.member?.id])).toEqual([['ASSIGNED', org.member.vp_ops]])
    const [late] = await getRouteStepDetails(org.ctxOf('req_con', TUE_1000), routeId)
    // Tuesday 10:00: 540 minutes used, 60 past the 480 it had
    expect(late!.sla).toMatchObject({ usedMinutes: 540, targetMinutes: 480, overdue: true })
  })

  it('stamps the decision with its channel and ends the SLA once the step is decided', async () => {
    const { requestId, routeId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    ok(await decideTask(org.ctxOf('vp_ops', MON_1300, 'LIFF'), { taskId: task.id, decision: 'APPROVE' }, key()))
    const [step] = await getRouteStepDetails(org.ctxOf('req_con', TUE_1000), routeId)
    expect(step).toMatchObject({ channel: 'LIFF', sla: null })
    expect(step!.history.map((h) => [h.what, h.decision, h.channel, h.member?.id])).toEqual([
      ['ASSIGNED', null, null, org.member.vp_ops],
      ['DECIDED', 'APPROVE', 'LIFF', org.member.vp_ops],
    ])
  })

  it('keeps the question in the history and does not count the time it waits for the answer (BR-SLA-03)', async () => {
    const { requestId, routeId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    ok(await requestInfo(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอใบเสนอราคาประกอบ' }, key()))
    const [step] = await getRouteStepDetails(org.ctxOf('req_con', TUE_1000), routeId)
    // Paused at 13:00 with 180 minutes used: it still has the 300 left, however long the requester takes
    expect(step!.sla).toMatchObject({ usedMinutes: 180, targetMinutes: 480, overdue: false })
    expect(step!.history.map((h) => [h.what, h.note])).toEqual([
      ['ASSIGNED', null],
      ['INFO_REQUESTED', 'ขอใบเสนอราคาประกอบ'],
    ])
  })
})

describe('[FR-INT-012/AC3] a moved task keeps the time its step has used', () => {
  it('counts from when the step’s first task arrived, not from the move, and says by how much it is past due', async () => {
    const { requestId, routeId } = await submitted('req_con', '45000.00')
    const first = await openTask(requestId)
    // A delegation moves the task at 13:00 (as delegation-window.ts does): a new task from now, with the same due time
    await prisma.approvalTask.update({ where: { id: first.id }, data: { status: 'REASSIGNED' } })
    await prisma.approvalTask.create({
      data: { organizationId: org.organizationId, stepId: first.stepId, assigneeMemberId: first.assigneeMemberId, resolvedFrom: first.resolvedFrom, status: 'OPEN', assignedAt: MON_1300, dueAt: first.dueAt, reassignedFromTaskId: first.id },
    })
    const [step] = await getRouteStepDetails(org.ctxOf('req_con', MON_1500), routeId)
    // 10:00 to 15:00: 300 of the 480 minutes, not the 120 since the move
    expect(step!.sla).toMatchObject({ usedMinutes: 300, targetMinutes: 480, overdue: false, overdueMinutes: null })
    const [late] = await getRouteStepDetails(org.ctxOf('req_con', TUE_1000), routeId)
    // Due Tuesday 09:00: an hour past it
    expect(late!.sla).toMatchObject({ usedMinutes: 540, targetMinutes: 480, overdue: true, overdueMinutes: 60 })
  })

  it('shows no due time while waiting for the requester’s answer', async () => {
    const { requestId, routeId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    ok(await requestInfo(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอสเปกสินค้า' }, key()))
    const [step] = await getRouteStepDetails(org.ctxOf('req_con', TUE_1000), routeId)
    expect(step!.sla).toMatchObject({ dueAt: null, overdue: false })
  })
})

describe('[FR-INT-012/AC4] the decision bar is offered only to the member who may decide an open task of the document', () => {
  it('finds the approver’s open task, nobody else’s, and nothing once it is decided', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    expect(await getMyOpenTaskId(org.ctxOf('vp_ops', NOW), 'REQUEST', requestId)).toBe(task.id)
    expect(await getMyOpenTaskId(org.ctxOf('req_con', NOW), 'REQUEST', requestId)).toBeNull()
    expect(await getMyOpenTaskId(org.ctxOf('ceo', NOW), 'REQUEST', requestId)).toBeNull()
    // The same id read as another document type finds nothing
    expect(await getMyOpenTaskId(org.ctxOf('vp_ops', NOW), 'PURCHASE_ORDER', requestId)).toBeNull()
    ok(await decideTask(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, decision: 'APPROVE' }, key()))
    expect(await getMyOpenTaskId(org.ctxOf('vp_ops', MON_1300), 'REQUEST', requestId)).toBeNull()
  })

  it('does not offer it while the task waits for the requester’s answer', async () => {
    const { requestId } = await submitted('req_con', '45000.00')
    const task = await openTask(requestId)
    ok(await requestInfo(org.ctxOf('vp_ops', MON_1300), { taskId: task.id, question: 'ขอรายละเอียดเพิ่ม' }, key()))
    expect(await getMyOpenTaskId(org.ctxOf('vp_ops', MON_1300), 'REQUEST', requestId)).toBeNull()
  })
})

describe('[FR-INT-012/AC2] [FR-INT-012/AC6] the POs of a request and the receipts and invoices of a PO', () => {
  it('lists the PO that orders the request’s lines, with no receipt or invoice yet, and the PO task for its approver', async () => {
    const supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-DOC', nameTh: 'ผู้ขายหน้าเอกสาร', taxId: '0999999000029' } })).id
    const flow = p2p(org, NOW)
    const request = await flow.approvedRequest(await flow.fundedLine(2_000_000n), [{ quantity: '2', unitPrice: '1000.00' }])
    const proc = org.ctxOf('proc_officer', NOW)
    expect(await listRequestPurchaseOrders(proc, request.id)).toEqual([])
    ok(await assignSupplier(proc, { requestLineIds: request.lines.map((l) => l.id), supplierId }, key()))
    const run = ok(await consolidateNow(proc, key()))
    const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, supplierId } })
    // A draft is procurement's work in progress: not shown on the request yet
    expect(await listRequestPurchaseOrders(proc, request.id)).toEqual([])
    ok(await submitPo(proc, { poId: po.id }, key()))
    const pos = await listRequestPurchaseOrders(proc, request.id)
    expect(pos).toEqual([{ id: po.id, number: expect.any(String), status: 'PENDING_APPROVAL', grossSatang: expect.any(BigInt), supplier: { th: 'ผู้ขายหน้าเอกสาร', en: null }, receipts: [] }])
    expect(await listPoReceipts(proc, po.id)).toEqual([])
    expect(await listPoInvoices(proc, po.id)).toEqual([])
    const poTask = await openTask(po.id)
    const approver = Object.entries(org.member).find(([, id]) => id === poTask.assigneeMemberId)![0]
    expect(await getMyOpenTaskId(org.ctxOf(approver, NOW), 'PURCHASE_ORDER', po.id)).toBe(poTask.id)
    expect(await getMyOpenTaskId(proc, 'PURCHASE_ORDER', po.id)).toBeNull()
  })

  it('reads nothing for an id that is not a uuid', async () => {
    const ctx = org.ctxOf('req_con', NOW)
    expect(await listRequestPurchaseOrders(ctx, 'not-a-uuid')).toEqual([])
    expect(await getRouteStepDetails(ctx, 'not-a-uuid')).toEqual([])
    expect(await getMyOpenTaskId(ctx, 'REQUEST', 'not-a-uuid')).toBeNull()
  })
})

describe('[FR-INT-012/AC1] the header counts the business days a document has taken', () => {
  const calendar = { timezone: 'Asia/Bangkok', workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const, start: '08:30', end: '17:30', holidays: [] }
  it('counts a whole business day as its 9 working hours, with one decimal', () => {
    // Monday 10:00 to Tuesday 10:00: 7.5 + 1.5 = 9 hours = 1 day; to Monday 13:00: 3 of 9 hours
    expect(businessDaysOf({ ...calendar, workdays: [...calendar.workdays] }, NOW, TUE_1000)).toBe(1)
    expect(businessDaysOf({ ...calendar, workdays: [...calendar.workdays] }, NOW, MON_1300)).toBe(0.3)
    expect(businessDaysOf({ ...calendar, workdays: [...calendar.workdays] }, TUE_1000, NOW)).toBe(0)
  })
})
