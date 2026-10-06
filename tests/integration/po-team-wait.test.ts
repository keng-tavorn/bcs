import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setEmailProvider } from '@/integrations/email-provider'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { getPurchaseOrderView, listPurchaseOrders, type DocTrackEntryDto } from '@/server/queries/purchase-orders'
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
// approved PO since its approval, a sent PO since it was sent — and the delivery step names the supplier. The list of POs
// says the same. Real Postgres (BCS_TEST_DB). Business days Mon–Fri 08:30–17:30 Asia/Bangkok, holidays 13 and 23 Oct
// 2026 (createDoaOrg); every time below is Thai time.

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

    // Part of it came: the rest waits on the same supplier, and its time is not counted (teamWaitSince)
    ok(await postGoodsReceipt(org.ctxOf('receiver_con', at('2026-10-08T14:00:00')), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '1' }] }, key()))
    const rest = await view(at('2026-10-08T15:00:00'), po.id)
    expect(rest.waiting).toEqual({ kind: 'REST' })
    expect(current(rest.track)).toEqual([expect.objectContaining({ what: 'WAIT_DELIVERY', at: null, waitingMinutes: null, supplierName: SUPPLIER })])
  })
})
