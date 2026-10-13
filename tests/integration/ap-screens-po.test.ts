import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { listMyTasks } from '@/server/queries/tasks'
import { getPoChangeTaskView } from '@/server/queries/po-changes'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { getPoChangeForm, getPoS8View } from '@/server/services/purchase-orders/view-change'
import { cancelChangeFor, createChangeFor, previewChangeFor, sendRevisionFor, setMilestonesFor, setRetentionFor, submitChangeFor } from '@/app/(workspace)/procurement/pos/[id]/s8-commands'
import { createDoaOrg } from '../support/doa-org'
import { p2p } from '../support/p2p'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, type ApOrg } from '../support/ap'

// S8-13 (FR-AP-106 AC1 AC5, FR-AP-107 AC2 AC3 AC5): what S8 adds to the purchase-order screens — the views that decide
// what the PO page and the change page show (tier-2 invoices and the draft's milestones and retention with module PAY
// on; the changes and "แก้ไข PO" with a PO_CHANGE rule in the DOA, never in a DEMO-like organization), the PO_CHANGE
// task view, and the commands behind the forms, with real Postgres and the real services.

let ap: ApOrg
const proc = () => ap.org.ctxOf('proc_officer', AP_NOW)
const k = () => randomUUID()
const versionOf = async (poChangeId: string) => (await prisma.poChange.findUniqueOrThrow({ where: { id: poChangeId } })).version

beforeAll(async () => {
  ap = await apOrg()
})

/** A draft SERVICE PO of the request lines (consolidated, not yet sent for approval) */
async function draftServicePo(target: ApOrg, lines: Array<{ quantity: string; unitPrice: string }>) {
  const ctx = target.org.ctxOf('proc_officer', AP_NOW)
  const budgetLineId = await target.flow.fundedLine(10_000_000n)
  const pr = await target.flow.approvedRequest(budgetLineId, lines)
  const site = await prisma.deliverySite.create({ data: { organizationId: target.org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์งาน', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: pr.id }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(ctx, { requestLineIds: pr.lines.map((l) => l.id), supplierId: target.supplierId }, key()))
  const run = ok(await consolidateNow(ctx, key()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'SERVICE' } })
  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
}

describe('[FR-AP-106/AC1] milestones and retention on the draft PO page', () => {
  it('a service draft offers its line for milestones; 30/40/30 splits it and the retention is saved from percent text', async () => {
    const po = await draftServicePo(ap, [{ quantity: '100', unitPrice: '50.00' }])
    const view = ok(await getPoS8View(proc(), po.id))
    expect(view.pay).toBe(true)
    expect(view.draft?.splittable.map((l) => l.id)).toEqual([po.lines[0]!.id])
    // FINANCE sees the PO (po.view ORG) but does not edit it: no milestone or retention fields
    expect(ok(await getPoS8View(fin(ap), po.id)).draft).toBeNull()

    expect(await setMilestonesFor(proc(), { poId: po.id, expectedVersion: view.version, poLineId: po.lines[0]!.id, shares: ['30', '40', 'x'] }, k())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'SHARES' })
    expect(await setMilestonesFor(proc(), { poId: po.id, expectedVersion: view.version, poLineId: po.lines[0]!.id, shares: ['30', '40', '30'] }, k())).toEqual({ ok: true })
    const lines = await prisma.poLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: 'asc' } })
    expect(lines.map((l) => l.milestoneShareBp)).toEqual([3000, 4000, 3000])
    const after = ok(await getPoS8View(proc(), po.id))
    expect(after.draft?.splittable).toEqual([])

    expect(await setRetentionFor(proc(), { poId: po.id, expectedVersion: after.version, retentionPercent: '5', holdDays: '180' }, k())).toEqual({ ok: true })
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ retentionBp: 500, retentionHoldDays: 180 })
    expect(ok(await getPoS8View(proc(), po.id)).draft).toMatchObject({ retentionBp: 500, retentionHoldDays: 180 })
  })
})

describe('[FR-AP-106/AC5] module PAY switched off', () => {
  it('the PO page has no tier-2 invoices, milestones or retention, and the command is MODULE_DISABLED', async () => {
    const off = await apOrg({ modules: [] })
    const po = await draftServicePo(off, [{ quantity: '10', unitPrice: '100.00' }])
    const ctx = off.org.ctxOf('proc_officer', AP_NOW)
    const view = ok(await getPoS8View(ctx, po.id))
    expect(view).toMatchObject({ pay: false, invoices: null, draft: null })
    expect(await setMilestonesFor(ctx, { poId: po.id, expectedVersion: view.version, poLineId: po.lines[0]!.id, shares: ['50', '50'] }, k())).toMatchObject({ ok: false, code: 'MODULE_DISABLED' })
  })
})

describe('[FR-AP-107/AC2] the change page and the PO_CHANGE task', () => {
  it('shows the bounds and the new totals from the server, drafts, sends for approval, shows the task, then cancels', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '1000.00' }])
    const line = po.lines[0]!
    const page = ok(await getPoS8View(proc(), po.id))
    expect(page).toMatchObject({ canChange: true, changes: [], revisionToSend: null })
    // FINANCE sees the PO and its changes but never the button (po.change is PROCUREMENT's)
    expect(ok(await getPoS8View(fin(ap), po.id)).canChange).toBe(false)

    const form = ok(await getPoChangeForm(proc(), po.id))
    expect(form).toMatchObject({ changeable: true, open: null })
    expect(form.lines[0]).toMatchObject({ id: line.id, quantity: '10', received: '0', invoiced: '0', minQuantity: '0', maxQuantity: '10', priceLocked: false })

    // the new totals come from the server (7% VAT on the PO); more than the request has left is refused with the line
    expect(await previewChangeFor(proc(), { poId: po.id, lines: [{ poLineId: line.id, newUnitPrice: '1100.00' }] })).toEqual({
      ok: true,
      totals: { oldNet: '10,000.00', oldVat: '700.00', oldGross: '10,700.00', newNet: '11,000.00', newVat: '770.00', newGross: '11,770.00' },
    })
    expect(await previewChangeFor(proc(), { poId: po.id, lines: [{ poLineId: line.id, newQuantity: '11' }] })).toMatchObject({ ok: false, code: 'PO_CHANGE_EXCEEDS_REQUEST', left: '0', lineNo: 1 })

    expect(await createChangeFor(proc(), { poId: po.id, reason: ' ', lines: [{ poLineId: line.id, newUnitPrice: '1100.00' }], deliveryDate: '', notesToSupplier: '' }, k())).toMatchObject({ ok: false, field: 'reason' })
    expect(await createChangeFor(proc(), { poId: po.id, reason: 'ราคาเหล็กขึ้น', lines: [{ poLineId: line.id, newUnitPrice: '1100.00' }], deliveryDate: '', notesToSupplier: '' }, k())).toEqual({ ok: true })
    expect(await createChangeFor(proc(), { poId: po.id, reason: 'อีกใบ', lines: [{ poLineId: line.id, newUnitPrice: '1200.00' }], deliveryDate: '', notesToSupplier: '' }, k())).toMatchObject({ ok: false, code: 'PO_CHANGE_OPEN' })
    const open = ok(await getPoChangeForm(proc(), po.id)).open!
    expect(open).toMatchObject({ changeNo: 1, status: 'DRAFT', autoApproved: false, new: { grossSatang: 1_177_000n } })
    expect(open.lines).toEqual([expect.objectContaining({ lineNo: 1, oldQuantity: '10', newQuantity: '10', oldUnitPriceSatang: 100_000n, newUnitPriceSatang: 110_000n })])

    expect(await submitChangeFor(proc(), { poChangeId: open.id, version: open.version }, k())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
    const task = await getPoChangeTaskView(proc(), open.id)
    expect(task).toMatchObject({ changeNo: 1, reason: 'ราคาเหล็กขึ้น', po: { number: po.number }, old: { grossSatang: 1_070_000n }, new: { netSatang: 1_100_000n, vatSatang: 77_000n, grossSatang: 1_177_000n } })
    expect(ok(await getPoS8View(proc(), po.id)).changes).toEqual([expect.objectContaining({ id: open.id, status: 'PENDING_APPROVAL' })])

    // the approver's inbox names it (S8-13): its number and supplier, not a task without a title
    const waiting = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'PO_CHANGE', subjectId: open.id } } }, select: { id: true, assigneeMemberId: true } })
    const approverCode = Object.entries(ap.org.member).find(([, id]) => id === waiting.assigneeMemberId)![0]
    const inbox = await listMyTasks(ap.org.ctxOf(approverCode, AP_NOW))
    expect(inbox.items.find((i) => i.id === waiting.id)?.subject).toEqual({ kind: 'PO_CHANGE', poChangeId: open.id, poNumber: po.number, changeNo: 1, supplierName: 'ผู้ขายหนึ่ง', grossSatang: 1_177_000n })

    expect(await cancelChangeFor(proc(), { poChangeId: open.id, version: await versionOf(open.id), reason: '' }, k())).toMatchObject({ ok: false, field: 'reason' })
    expect(await cancelChangeFor(proc(), { poChangeId: open.id, version: await versionOf(open.id), reason: 'ผู้ขายคงราคาเดิม' }, k())).toEqual({ ok: true })
    expect(ok(await getPoChangeForm(proc(), po.id)).open).toBeNull()
  })

  it('PROCUREMENT only: FINANCE is FORBIDDEN on the change page and its commands', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '100.00' }])
    expect(await getPoChangeForm(fin(ap), po.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await previewChangeFor(fin(ap), { poId: po.id, lines: [] })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await createChangeFor(fin(ap), { poId: po.id, reason: 'x', lines: [{ poLineId: po.lines[0]!.id, newUnitPrice: '90.00' }], deliveryDate: '', notesToSupplier: '' }, k())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('[FR-AP-107/AC3] the revision to send', () => {
  it('a change of the date alone is approved at once; the page offers its revision until it is sent', async () => {
    await prisma.supplier.update({ where: { id: ap.supplierId }, data: { email: `rev-${randomUUID().slice(0, 8)}@test.bcs.local` } })
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '500.00' }])
    expect(await createChangeFor(proc(), { poId: po.id, reason: 'ผู้ขายขอเลื่อน', lines: [], deliveryDate: '2026-11-30', notesToSupplier: '' }, k())).toEqual({ ok: true })
    const open = ok(await getPoChangeForm(proc(), po.id)).open!
    expect(open).toMatchObject({ autoApproved: true, deliveryDate: '2026-11-30' })
    expect(await submitChangeFor(proc(), { poChangeId: open.id, version: open.version }, k())).toEqual({ ok: true, status: 'APPROVED' })
    expect(ok(await getPoS8View(proc(), po.id)).revisionToSend).toEqual({ revisionNo: 1, changeNo: 1 })
    expect(ok(await getPoChangeForm(proc(), po.id)).po.deliveryDate).toBe('2026-11-30')
    expect(await sendRevisionFor(proc(), po.id, k())).toEqual({ ok: true })
    expect(ok(await getPoS8View(proc(), po.id)).revisionToSend).toBeNull()
  })
})

describe('tier-2 invoices on the PO page (module PAY)', () => {
  it('lists the PO’s invoices with their status and payable', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `SCR-${randomUUID().slice(0, 6)}`, vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    const view = ok(await getPoS8View(fin(ap), po.id))
    expect(view.invoices).toEqual([expect.objectContaining({ id: draft.invoiceId, status: 'DRAFT', number: null })])
  })
})

describe('[FR-AP-107/AC5] a DOA without a PO_CHANGE rule (as DEMO)', () => {
  it('no "แก้ไข PO", no changes tab, and the change page says DOA_NOT_CONFIGURED', async () => {
    const org = await createDoaOrg()
    const flow = p2p(org, AP_NOW)
    const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขาย', taxId: '0999999000012', email: 'demo-like@test.bcs.local' } })
    const budgetLineId = await flow.fundedLine(1_000_000n)
    const pr = await flow.approvedRequest(budgetLineId, [{ quantity: '1', unitPrice: '1000.00' }])
    const po = await flow.approvedPo(
      pr.lines.map((l) => l.id),
      supplier.id,
    )
    const ctx = org.ctxOf('proc_officer', AP_NOW)
    expect(ok(await getPoS8View(ctx, po.id))).toMatchObject({ canChange: false, changes: null, revisionToSend: null })
    expect(await getPoChangeForm(ctx, po.id)).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
    expect(await createChangeFor(ctx, { poId: po.id, reason: 'x', lines: [{ poLineId: po.lines[0]!.id, newUnitPrice: '1100.00' }], deliveryDate: '', notesToSupplier: '' }, k())).toMatchObject({ ok: false, code: 'DOA_NOT_CONFIGURED' })
  })
})
