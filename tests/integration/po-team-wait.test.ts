import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider } from '@/integrations/email-provider'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getPurchaseOrderView, listPurchaseOrders, type DocTrackEntryDto } from '@/server/queries/purchase-orders'
import { getRequestView, listMyRequests } from '@/server/queries/requests'
import { decideTask } from '@/server/services/approvals/decide'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { sendPurchaseOrder } from '@/server/services/purchase-orders/send'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'

// §9.9 principle 4 and FR-INT-008 AC1 on a purchase order (src/server/queries/purchase-orders.ts): while a PO waits on
// procurement or on its supplier, "whom it waits for" and the timeline's current step carry the business minutes it has
// waited since it entered the state it is in — a draft since the round drafted it or its approver returned it, an
// approved PO since its approval, a sent PO since it was sent — and the delivery step names the supplier. Once goods
// came, a PO partly received waits for the rest of its goods, and one received in full for its invoice and closing,
// both since its latest posted goods receipt. The list of POs says the same. Real Postgres (BCS_TEST_DB). Business days
// Mon–Fri 08:30–17:30 Asia/Bangkok, holidays 13 and 23 Oct 2026 (createDoaOrg); every time below is Thai time.

const at = (thai: string) => new Date(`${thai}+07:00`)
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const SUPPLIER = 'บริษัท ผู้ขายรอส่งของ จำกัด'

let org: DoaOrg
let supplierId: string
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S-WAIT', nameTh: SUPPLIER, taxId: '0999999000063', email: 'wait@supplier.test' } })).id
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: at('2026-10-01T08:00:00') } })
})

afterEach(() => setEmailProvider(null))

const proc = (when: Date) => org.ctxOf('proc_officer', when)
const codeOf = (memberId: string) => Object.entries(org.member).find(([, id]) => id === memberId)![0]
const view = async (when: Date, poId: string) => (await getPurchaseOrderView(proc(when), poId))!
const rowOf = async (when: Date, poId: string) => (await listPurchaseOrders(proc(when))).rows.find((r) => r.id === poId)!
const current = (track: readonly DocTrackEntryDto[]) => track.filter((e) => e.state === 'current')
const openTask = (poId: string) => prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: poId } } } })

/** A draft PO of one request line of 2 pieces at 1,000.00, made by procurement's round at `when` on a site of its own */
async function draftAt(when: Date) {
  const flow = p2p(org, when)
  const request = await flow.approvedRequest(await flow.fundedLine(100_000n), [{ quantity: '2', unitPrice: '1000.00' }])
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์ทดสอบ', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: request.id }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(proc(when), { requestLineIds: request.lines.map((l) => l.id), supplierId }, key()))
  const run = ok(await consolidateNow(proc(when), key()))
  return prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: true } })
}

describe('[FR-INT-008/AC1] a PO waiting on procurement or its supplier says for how many business hours (§9.9 principle 4)', () => {
  it('a draft waits since it was drafted, in business time only, and since its return once its approver returned it', async () => {
    const drafted = at('2026-10-05T10:00:00') // Monday
    const po = await draftAt(drafted)
    // Monday 11:30: an hour and a half; the list says the same
    const monday = await view(at('2026-10-05T11:30:00'), po.id)
    expect(monday.waiting).toEqual({ kind: 'EDIT', waitingMinutes: 90 })
    expect(current(monday.track)).toEqual([expect.objectContaining({ what: 'WAIT_EDIT', at: drafted, actor: null, waitingMinutes: 90 })])
    expect(current(monday.track)[0]).not.toHaveProperty('supplierName')
    expect((await rowOf(at('2026-10-05T11:30:00'), po.id)).waiting).toEqual({ kind: 'EDIT', waitingMinutes: 90 })
    // Tuesday 09:00: Monday 10:00–17:30 and Tuesday 08:30–09:00 — the night is not counted
    expect((await view(at('2026-10-06T09:00:00'), po.id)).waiting).toEqual({ kind: 'EDIT', waitingMinutes: 480 })

    // Sent for approval on Tuesday at 09:00 and returned at 10:00: a draft again, waiting since the return
    ok(await submitPo(proc(at('2026-10-06T09:00:00')), { poId: po.id }, key()))
    const task = await openTask(po.id)
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), at('2026-10-06T10:00:00')), { taskId: task.id, decision: 'RETURN', reason: 'ต่อราคาอีกครั้ง' }, key()))
    const returned = await view(at('2026-10-06T10:45:00'), po.id)
    expect(returned).toMatchObject({ status: 'DRAFT', waiting: { kind: 'EDIT', waitingMinutes: 45 } })
    expect(current(returned.track)).toEqual([expect.objectContaining({ what: 'WAIT_EDIT', at: at('2026-10-06T10:00:00'), waitingMinutes: 45 })])
    expect((await rowOf(at('2026-10-06T10:45:00'), po.id)).waiting).toEqual({ kind: 'EDIT', waitingMinutes: 45 })
  })

  it('an approved PO waits since its approval and a sent one since it was sent; the delivery step names the supplier', async () => {
    const po = await draftAt(at('2026-10-07T09:00:00')) // Wednesday
    ok(await submitPo(proc(at('2026-10-07T09:30:00')), { poId: po.id }, key()))
    await p2p(org, at('2026-10-07T11:30:00')).approveAll(po.id)
    const approved = await view(at('2026-10-07T13:00:00'), po.id)
    expect(approved.waiting).toEqual({ kind: 'SEND', bounced: false, waitingMinutes: 90 })
    expect(current(approved.track)).toEqual([expect.objectContaining({ what: 'WAIT_SEND', at: at('2026-10-07T11:30:00'), actor: null, waitingMinutes: 90 })])
    expect((await rowOf(at('2026-10-07T13:00:00'), po.id)).waiting).toEqual({ kind: 'SEND', bounced: false, waitingMinutes: 90 })

    // Sent on Thursday at 08:00, before the business day: by 10:00 it has waited from 08:30
    setEmailProvider({ send: async () => ({ messageId: randomUUID() }) })
    ok(await sendPurchaseOrder(proc(at('2026-10-08T08:00:00')), { poId: po.id }, key()))
    const sent = await view(at('2026-10-08T10:00:00'), po.id)
    expect(sent.waiting).toEqual({ kind: 'DELIVERY', waitingMinutes: 90 })
    expect(current(sent.track)).toEqual([expect.objectContaining({ what: 'WAIT_DELIVERY', at: at('2026-10-08T08:00:00'), actor: null, waitingMinutes: 90, supplierName: SUPPLIER })])
    expect((await rowOf(at('2026-10-08T10:00:00'), po.id)).waiting).toEqual({ kind: 'DELIVERY', waitingMinutes: 90 })
  })

  it('[FR-INT-008/AC1] its ordered request waits for the supplier of the sent PO, by name, for as long as the PO has: in "my requests" and on its page', async () => {
    const po = await draftAt(at('2026-10-07T09:00:00')) // Wednesday
    const source = await prisma.poLineSource.findFirstOrThrow({ where: { poLineId: po.lines[0]!.id }, select: { requestLine: { select: { requestId: true } } } })
    const requestId = source.requestLine.requestId
    const mine = async (when: Date) => (await listMyRequests(org.ctxOf('req_con', when))).rows.find((r) => r.id === requestId)!
    ok(await submitPo(proc(at('2026-10-07T09:30:00')), { poId: po.id }, key()))
    await p2p(org, at('2026-10-07T11:30:00')).approveAll(po.id)
    // Approved, not sent yet: ordered, and no supplier has it yet — nobody is named, no time is counted
    const ordered = await mine(at('2026-10-07T13:00:00'))
    expect(ordered.status).toBe('ORDERED')
    expect(ordered.stage).toEqual({ kind: 'DELIVERY', since: null, waitingMinutes: null, suppliers: [] })

    // Sent on Thursday at 08:00: the request waits for that supplier, from the business day's start, as the PO does
    setEmailProvider({ send: async () => ({ messageId: randomUUID() }) })
    ok(await sendPurchaseOrder(proc(at('2026-10-08T08:00:00')), { poId: po.id }, key()))
    const waiting = { kind: 'DELIVERY', since: at('2026-10-08T08:00:00'), waitingMinutes: 90, suppliers: [{ th: SUPPLIER, en: null }] }
    expect((await mine(at('2026-10-08T10:00:00'))).stage).toEqual(waiting)
    const page = (await getRequestView(org.ctxOf('req_con', at('2026-10-08T10:00:00')), requestId))!
    expect(page.stage).toEqual(waiting)
    expect(page.track.filter((e) => e.state === 'current')).toEqual([
      expect.objectContaining({ what: 'WAIT_DELIVERY', at: at('2026-10-08T08:00:00'), actor: null, waitingMinutes: 90, suppliers: [{ th: SUPPLIER, en: null }] }),
    ])
  })

  it('a PO partly received waits for the rest since its latest goods receipt, and one received in full for its invoice and closing since the receipt that completed it', async () => {
    const po = await draftAt(at('2026-10-07T09:00:00')) // Wednesday
    ok(await submitPo(proc(at('2026-10-07T09:30:00')), { poId: po.id }, key()))
    await p2p(org, at('2026-10-07T11:30:00')).approveAll(po.id)
    setEmailProvider({ send: async () => ({ messageId: randomUUID() }) })
    ok(await sendPurchaseOrder(proc(at('2026-10-08T08:00:00')), { poId: po.id }, key()))
    const receive = (when: Date) => postGoodsReceipt(org.ctxOf('receiver_con', when), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '1' }] }, key())

    // One of the two pieces came on Thursday at 14:00: the rest waits on the same supplier from that receipt, not from
    // the sending; the list says the same
    ok(await receive(at('2026-10-08T14:00:00')))
    const rest = await view(at('2026-10-08T15:00:00'), po.id)
    expect(rest).toMatchObject({ status: 'PARTIALLY_RECEIVED' })
    expect(rest.waiting).toEqual({ kind: 'REST', waitingMinutes: 60 })
    expect(current(rest.track)).toEqual([expect.objectContaining({ what: 'WAIT_DELIVERY', at: at('2026-10-08T14:00:00'), actor: null, waitingMinutes: 60, supplierName: SUPPLIER })])
    expect((await rowOf(at('2026-10-08T15:00:00'), po.id)).waiting).toEqual({ kind: 'REST', waitingMinutes: 60 })

    // The other came on Friday at 16:30: received in full, it waits for its invoice and its closing from that receipt —
    // Friday 16:30–17:30 and Monday 08:30–09:30, never the weekend nor the time before the first receipt
    ok(await receive(at('2026-10-09T16:30:00')))
    const received = await view(at('2026-10-12T09:30:00'), po.id)
    expect(received).toMatchObject({ status: 'RECEIVED' })
    expect(received.waiting).toEqual({ kind: 'CLOSE', waitingMinutes: 120 })
    expect(current(received.track)).toEqual([expect.objectContaining({ what: 'WAIT_CLOSE', at: at('2026-10-09T16:30:00'), actor: null, waitingMinutes: 120 })])
    // The closing waits on procurement, not on the supplier
    expect(current(received.track)[0]).not.toHaveProperty('supplierName')
    expect((await rowOf(at('2026-10-12T09:30:00'), po.id)).waiting).toEqual({ kind: 'CLOSE', waitingMinutes: 120 })
  })
})
