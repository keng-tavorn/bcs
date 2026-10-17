import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { decideTask } from '@/server/services/approvals/decide'
import { recheckPoInvoices } from '@/server/services/ap/exceptions'
import { cancelPurchaseOrder, closePurchaseOrder } from '@/server/services/purchase-orders'
import { cancelPoChange, createPoChange, sendPoRevision, submitPoChange } from '@/server/services/purchase-orders/change'
import { verifyDocument } from '@/server/services/documents/verification'
import { verificationToken } from '@/server/verification/token'
import { createDoaOrg } from '../support/doa-org'
import { messagesTo } from '../support/mailpit'
import { p2p } from '../support/p2p'
import { stepUpForTask } from '../support/pin'
import { AP_NOW, apOrg, codedDraft, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-10 (FR-AP-107, BR-POC-01 to BR-POC-05, ADR-125): a change to a sent PO under DOA PO_CHANGE — the reservation of an
// increase at submit, SoD, the last approval that applies it (or refuses PO_CHANGE_BELOW_PROGRESS when the PO moved
// meanwhile, with the task still open), a change of the date alone approved at once, the revision e-mailed with its
// PDF, the invoices waiting in EXCEPTION matched again, and an organization whose DOA has no PO_CHANGE rule.

let ap: ApOrg
const proc = () => ap.org.ctxOf('proc_officer', AP_NOW)
const codeOf = (memberId: string) => Object.entries(ap.org.member).find(([, id]) => id === memberId)![0]
const openTaskOf = (poChangeId: string) => prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectType: 'PO_CHANGE', subjectId: poChangeId } } } })
const versionOf = async (poChangeId: string) => (await prisma.poChange.findUniqueOrThrow({ where: { id: poChangeId } })).version
const held = async (poLineId: string) => prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: poLineId } })

beforeAll(async () => {
  ap = await apOrg()
})

async function approveByDoa(poChangeId: string) {
  const task = (await openTaskOf(poChangeId))!
  await stepUpForTask(task.id, task.assigneeMemberId)
  return decideTask(ap.org.ctxOf(codeOf(task.assigneeMemberId), AP_NOW), { taskId: task.id, decision: 'APPROVE' }, key())
}

describe('[FR-AP-107/AC2] [FR-AP-107/AC3] a price change under DOA PO_CHANGE', () => {
  it('reserves the increase at submit, the PO creator may not approve, the last approval makes revision 1 that is e-mailed with its PDF', async () => {
    const address = `supplier-${randomUUID().slice(0, 8)}@test.bcs.local`
    await prisma.supplier.update({ where: { id: ap.supplierId }, data: { email: address } })
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
    const line = po.lines[0]!
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ราคาเหล็กขึ้น', lines: [{ poLineId: line.id, newUnitPrice: '1100.00' }] }, key()))
    expect(await createPoChange(proc(), { poId: po.id, reason: 'อีกใบ', lines: [{ poLineId: line.id, newUnitPrice: '1200.00' }] }, key())).toMatchObject({ ok: false, error: { code: 'PO_CHANGE_OPEN' } })
    const submitted = ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    expect(submitted.status).toBe('PENDING_APPROVAL')
    expect(await prisma.approvalRoute.findFirstOrThrow({ where: { subjectType: 'PO_CHANGE', subjectId: drafted.poChangeId } })).toMatchObject({ ruleCode: 'PC-01' })
    expect(await held(line.id)).toMatchObject({ reservedSatang: 100_000n, committedSatang: 1_000_000n })

    // BR-POC-02: the PO's creator does not approve its change
    const task = (await openTaskOf(drafted.poChangeId))!
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: po.createdById! } })
    await stepUpForTask(task.id, po.createdById!)
    expect(await decideTask(ap.org.ctxOf(codeOf(po.createdById!), AP_NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
    await prisma.approvalTask.update({ where: { id: task.id }, data: { assigneeMemberId: task.assigneeMemberId } })

    ok(await approveByDoa(drafted.poChangeId))
    expect(await prisma.poLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ unitPriceSatang: 110_000n, netSatang: 1_100_000n })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ netSatang: 1_100_000n, revisionNo: 1 })
    expect(await held(line.id)).toMatchObject({ reservedSatang: 0n, committedSatang: 1_100_000n })
    expect(await prisma.poChange.findUniqueOrThrow({ where: { id: drafted.poChangeId } })).toMatchObject({ status: 'APPROVED', appliedRevisionNo: 1 })

    const sent = ok(await sendPoRevision(proc(), { poId: po.id }, key()))
    expect(sent.revisionNo).toBe(1)
    const mails = await messagesTo(address)
    expect(mails.at(-1)!.Attachments.map((a) => a.FileName)).toEqual([expect.stringMatching(/-rev1\.pdf$/)])
    expect(mails.at(-1)!.Subject).toContain('แก้ไขครั้งที่ 1')
  })

  it('a change of the date alone is approved at once: a new revision, no task, no budget move', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '500.00' }])
    const before = await held(po.lines[0]!.id)
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ผู้ขายขอเลื่อน', deliveryDate: '2026-11-30' }, key()))
    expect(drafted.autoApproved).toBe(true)
    expect(ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))).toMatchObject({ status: 'APPROVED', routeId: null, revisionNo: 1 })
    expect(await prisma.approvalRoute.count({ where: { subjectType: 'PO_CHANGE', subjectId: drafted.poChangeId } })).toBe(0)
    expect(await held(po.lines[0]!.id)).toMatchObject({ reservedSatang: before.reservedSatang, committedSatang: before.committedSatang })
  })
})

describe('[FR-AP-107/AC4] the PO moved while the change waited', () => {
  it('a decrease below what was received meanwhile: PO_CHANGE_BELOW_PROGRESS at the last approval, the task stays open and nothing changes', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    const line = po.lines[0]!
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ลดจำนวน', lines: [{ poLineId: line.id, newQuantity: '8' }] }, key()))
    ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    await receive(ap, po, { 0: '9' })
    expect(await approveByDoa(drafted.poChangeId)).toMatchObject({ ok: false, error: { code: 'PO_CHANGE_BELOW_PROGRESS', details: { reason: 'RECEIVED' } } })
    expect(await openTaskOf(drafted.poChangeId)).not.toBeNull()
    expect(await prisma.poLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ netSatang: 100_000n })
    // cancelled, the change gives back nothing it did not take and closes its route
    ok(await cancelPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId), reason: 'รับครบแล้ว' }, key()))
    expect(await openTaskOf(drafted.poChangeId)).toBeNull()
    expect(await held(line.id)).toMatchObject({ reservedSatang: 0n, committedSatang: 100_000n })
  })

  it('an approved price change matches the PO’s invoice waiting in EXCEPTION again (BR-POC-04)', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `PC-${randomUUID().slice(0, 6)}`, date: '2026-09-01', vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
    expect(ok(await submit(ap, draft)).status).toBe('EXCEPTION')
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ราคาตามใบแจ้งหนี้', lines: [{ poLineId: po.lines[0]!.id, newUnitPrice: '1100.00' }] }, key()))
    ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    ok(await approveByDoa(drafted.poChangeId))
    // the job invoice-auto-recheck runs on po_change.approved
    const [r] = await recheckPoInvoices(ap.org.organizationId, po.id, `po_change:${drafted.poChangeId}`, AP_NOW)
    expect(r).toMatchObject({ ok: true, data: { status: 'READY_FOR_PAYMENT' } })
  })
})

describe('[FR-AP-107/AC1] S8-14 review: the money and the quantity of a line moving opposite ways, and the PO received', () => {
  it('a price rise with fewer units back to the pool: the PO line holds the new amount, the request line gets the removed units reserved again, and the request status moves with an Event', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
    const line = po.lines[0]!
    const source = await prisma.poLineSource.findFirstOrThrow({ where: { poLineId: line.id } })
    const requestReserved = async () => (await prisma.budgetAllocation.findFirst({ where: { sourceType: 'REQUEST_LINE', sourceId: source.requestLineId } }))?.reservedSatang ?? 0n
    const reservedBefore = await requestReserved()
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ราคาขึ้น สั่งน้อยลง', lines: [{ poLineId: line.id, newQuantity: '8', newUnitPrice: '1300.00' }], quantityDisposition: 'RETURN_TO_POOL' }, key()))
    ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    ok(await approveByDoa(drafted.poChangeId))
    expect(await held(line.id)).toMatchObject({ reservedSatang: 0n, committedSatang: 1_040_000n })
    const sourceAfter = await prisma.poLineSource.findUniqueOrThrow({ where: { id: source.id } })
    // the 2 units taken off are the request line's again, reserved at their releasable
    expect(await requestReserved()).toBe(reservedBefore + (source.releasableSatang - sourceAfter.releasableSatang))
    const request = await prisma.requestLine.findUniqueOrThrow({ where: { id: source.requestLineId }, select: { requestId: true, request: { select: { status: true } } } })
    expect(request.request.status).toBe('PARTIALLY_ORDERED')
    const revised = await prisma.event.findFirstOrThrow({ where: { type: 'po.revised', aggregateId: po.id }, orderBy: { seq: 'desc' } })
    expect(revised.data).toMatchObject({ requests: [{ requestId: request.requestId, status: 'PARTIALLY_ORDERED' }] })
  })

  it('a PO received in full takes no more units, and a PO partly received is not cut to what came in (PO_CHANGE_BELOW_PROGRESS)', async () => {
    const full = await sentPo(ap, [{ quantity: '2', unitPrice: '100.00' }])
    await receive(ap, full, { 0: '2' })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: full.id } })).toMatchObject({ status: 'RECEIVED' })
    expect(await createPoChange(proc(), { poId: full.id, reason: 'เพิ่ม', lines: [{ poLineId: full.lines[0]!.id, newQuantity: '3' }] }, key())).toMatchObject({ ok: false, error: { code: 'PO_CHANGE_BELOW_PROGRESS', details: { reason: 'RECEIVED_IN_FULL' } } })
    // its price may still change before an invoice comes
    ok(await createPoChange(proc(), { poId: full.id, reason: 'ราคา', lines: [{ poLineId: full.lines[0]!.id, newUnitPrice: '110.00' }] }, key()))

    const part = await sentPo(ap, [{ quantity: '5', unitPrice: '100.00' }])
    await receive(ap, part, { 0: '3' })
    expect(await createPoChange(proc(), { poId: part.id, reason: 'ตัดเหลือที่รับ', lines: [{ poLineId: part.lines[0]!.id, newQuantity: '3' }] }, key())).toMatchObject({ ok: false, error: { code: 'PO_CHANGE_BELOW_PROGRESS', details: { reason: 'CLOSE_SHORT_INSTEAD' } } })
    ok(await createPoChange(proc(), { poId: part.id, reason: 'ลดเหลือ 4', lines: [{ poLineId: part.lines[0]!.id, newQuantity: '4' }] }, key()))
  })
})

describe('[FR-DOA-102/AC1] S6-19 with S8: the approved PO change prints a new verification QR (BR-QR-01, BR-POC-04)', () => {
  it('the revision issues a new row; the QR of the copy before says a newer version exists', async () => {
    const po = await sentPo(ap, [{ quantity: '4', unitPrice: '500.00' }])
    const before = await prisma.documentVerification.findFirstOrThrow({ where: { subjectType: 'PURCHASE_ORDER', subjectId: po.id, supersededAt: null } })
    const oldToken = verificationToken(before.id)
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ราคาขึ้นตามใบเสนอใหม่', lines: [{ poLineId: po.lines[0]!.id, newUnitPrice: '550.00' }] }, key()))
    ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    ok(await approveByDoa(drafted.poChangeId))
    const rows = await prisma.documentVerification.findMany({ where: { subjectType: 'PURCHASE_ORDER', subjectId: po.id }, orderBy: { issuedAt: 'asc' } })
    expect(rows).toHaveLength(2)
    expect(rows[1]!.supersededAt).toBeNull()
    expect(await verifyDocument(oldToken, null)).toMatchObject({ latest: false })
    expect(await verifyDocument(verificationToken(rows[1]!.id), null)).toMatchObject({ latest: true })
  })
})

describe('[FR-AP-107/AC5] a DOA without a PO_CHANGE rule (as DEMO)', () => {
  it('po_change.create is DOA_NOT_CONFIGURED and nothing is drafted or reserved', async () => {
    const org = await createDoaOrg()
    const flow = p2p(org, AP_NOW)
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขาย', taxId: '0999999000012', email: 'demo-like@test.bcs.local' } })
    const budgetLineId = await flow.fundedLine(1_000_000n)
    const pr = await flow.approvedRequest(budgetLineId, [{ quantity: '1', unitPrice: '1000.00' }])
    const po = await flow.approvedPo(pr.lines.map((l) => l.id), supplier.id)
    const before = await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })
    expect(await createPoChange(org.ctxOf('proc_officer', AP_NOW), { poId: po.id, reason: 'x', lines: [{ poLineId: po.lines[0]!.id, newUnitPrice: '1100.00' }] }, key())).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
    expect(await prisma.poChange.count({ where: { poId: po.id } })).toBe(0)
    expect(await prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId } })).toEqual(before)
  })
})

describe('[BR-POC-01] a PO with a change not finished is neither cancelled nor closed; a line closed short changes no quantity (ADR-073 pre-review)', () => {
  it('cancel and close are PO_CHANGE_OPEN while the change waits; once it is cancelled the PO is cancelled and an approval of nothing is left', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
    const line = po.lines[0]!
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ราคาเหล็กขึ้น', lines: [{ poLineId: line.id, newUnitPrice: '1100.00' }] }, key()))
    ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    expect(await cancelPurchaseOrder(proc(), { poId: po.id, disposition: 'RETURN_TO_POOL', reason: 'ผู้ขายเลิกกิจการ' }, key())).toMatchObject({ ok: false, error: { code: 'PO_CHANGE_OPEN' } })
    expect(await closePurchaseOrder(proc(), { poId: po.id }, key())).toMatchObject({ ok: false })
    expect(await held(line.id)).toMatchObject({ reservedSatang: 100_000n, committedSatang: 1_000_000n })
    ok(await cancelPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId), reason: 'ไม่แก้แล้ว' }, key()))
    ok(await cancelPurchaseOrder(proc(), { poId: po.id, disposition: 'RETURN_TO_POOL', reason: 'ผู้ขายเลิกกิจการ' }, key()))
  })

  it('a change approved after its PO was cancelled is refused, and nothing is committed on the cancelled PO', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
    const line = po.lines[0]!
    const drafted = ok(await createPoChange(proc(), { poId: po.id, reason: 'ราคาเหล็กขึ้น', lines: [{ poLineId: line.id, newUnitPrice: '1100.00' }] }, key()))
    ok(await submitPoChange(proc(), { poChangeId: drafted.poChangeId, version: await versionOf(drafted.poChangeId) }, key()))
    // a PO cancelled behind the change's back (as before this fix)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'CANCELLED' } })
    expect(await approveByDoa(drafted.poChangeId)).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED' } } })
    expect(await prisma.poLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ unitPriceSatang: 100_000n })
  })

  it('the quantity of a line closed short does not change (CLOSED_SHORT); its price still may', async () => {
    const po = await sentPo(ap, [
      { quantity: '10', unitPrice: '100.00' },
      { quantity: '5', unitPrice: '100.00' },
    ])
    await receive(ap, po, { 0: '6' })
    await prisma.poLine.update({ where: { id: po.lines[0]!.id }, data: { cancelledQuantity: '4' } })
    expect(await createPoChange(proc(), { poId: po.id, reason: 'ลดจำนวน', lines: [{ poLineId: po.lines[0]!.id, newQuantity: '6' }] }, key())).toMatchObject({ ok: false, error: { code: 'PO_CHANGE_BELOW_PROGRESS', details: { reason: 'CLOSED_SHORT' } } })
    ok(await createPoChange(proc(), { poId: po.id, reason: 'ลดราคา', lines: [{ poLineId: po.lines[0]!.id, newUnitPrice: '95.00' }] }, key()))
  })
})
