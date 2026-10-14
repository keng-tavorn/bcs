import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { MS_PER_DAY } from '@/lib/constants'
import { systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { setPoMilestones, setPoRetention } from '@/server/services/ap/milestones'
import { holdInvoicesForPayment, recordInvoicePayment } from '@/server/services/ap/payment'
import { holdRetentionsForPayment, markDueRetentions, releaseRetention, releaseRetentionsFromPayment } from '@/server/services/ap/retention'
import { confirmIncomeType, updateIncomeType, updateSupplierTaxProfile } from '@/server/services/ap/wht'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { submitPo } from '@/server/services/purchase-orders'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, submit, type ApOrg } from '../support/ap'

// S8-09 (FR-AP-106, BR-RET-01 to BR-RET-04, ADR-124): a road contract of 9,500 m² × 260.00 split 30/40/30 while the PO
// is a draft (GC-RET-01), each milestone received with a goods receipt and invoiced as a service; the invoice of
// milestone 1 holds back 5% (GC-RET-05) and expects 3% tax on the rest; the retention is due 365 days after the last
// milestone's receipt, released by FINANCE from that day, and paid by S9 with the invoice in one item (GC-WHT-21).

let ap: ApOrg
const proc = () => ap.org.ctxOf('proc_officer', AP_NOW)
const s9 = (now = AP_NOW) => systemCtx(ap.org.organizationId, now, 'payment-run')
const later = (days: number) => new Date(AP_NOW.getTime() + days * MS_PER_DAY)

beforeAll(async () => {
  ap = await apOrg()
  ok(await updateIncomeType(fin(ap), { code: 'CONTRACT', nameTh: 'ค่าจ้างทำของ', rateBp: 300, form: 'PND3_53', active: true }, key()))
  ok(await confirmIncomeType(ap.org.ctxOf('dm_fin', AP_NOW), { code: 'CONTRACT' }, key()))
  ok(await updateSupplierTaxProfile(fin(ap), { supplierId: ap.supplierId, payeeType: 'JURISTIC', defaultWhtIncomeTypeCode: 'CONTRACT' }, key()))
  // the organization's request type holds back 5% (data, BR-RET-03)
  await prisma.requestType.updateMany({ where: { organizationId: ap.org.organizationId, code: 'BUY_GOODS' }, data: { defaultRetentionBp: 500, defaultRetentionHoldDays: 365 } })
})

/** A draft SERVICE PO of the request lines (consolidated, not yet sent for approval) */
async function draftServicePo(lines: Array<{ quantity: string; unitPrice: string }>) {
  const budgetLineId = await ap.flow.fundedLine(10_000_000n)
  await prisma.budgetLine.update({ where: { id: budgetLineId }, data: { accountCode: '510101' } })
  const pr = await ap.flow.approvedRequest(budgetLineId, lines)
  const site = await prisma.deliverySite.create({ data: { organizationId: ap.org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์งานถนน', address: 'ถนนทดสอบ' } })
  await prisma.request.update({ where: { id: pr.id }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(proc(), { requestLineIds: pr.lines.map((l) => l.id), supplierId: ap.supplierId }, key()))
  const run = ok(await consolidateNow(proc(), key()))
  const po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id } })
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'SERVICE' } })
  return prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
}

const linesOf = (poId: string) => prisma.poLine.findMany({ where: { poId }, orderBy: { lineNo: 'asc' }, include: { sources: true } })

async function inS9<T extends { ok: boolean }>(ctx: Ctx, run: (tx: Parameters<Parameters<ReturnType<typeof forTenant>['$transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return forTenant(ap.org.organizationId).$transaction(async (tx) => {
    const r = await run(tx)
    if (r.ok && 'events' in r) await appendEvents(tx, ctx, r.events as never)
    return r
  })
}

describe('[FR-AP-106/AC1] milestones of a draft service PO', () => {
  it('a new PO starts with its request type’s retention; 30/40/30 makes three lines with their own sources (GC-RET-01)', async () => {
    const po = await draftServicePo([{ quantity: '9500', unitPrice: '260.00' }])
    expect(po).toMatchObject({ retentionBp: 500, retentionHoldDays: 365 })
    expect(await setPoMilestones(proc(), { poId: po.id, expectedVersion: po.version, poLineId: po.lines[0]!.id, sharesBp: [5000, 4999] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SHARES' } } })
    ok(await setPoMilestones(proc(), { poId: po.id, expectedVersion: po.version, poLineId: po.lines[0]!.id, sharesBp: [3000, 4000, 3000] }, key()))
    const lines = await linesOf(po.id)
    expect(lines.map((l) => [l.lineNo, l.milestoneNo, l.quantity.toString(), l.netSatang, l.sources[0]!.quantity.toString()])).toEqual([
      [1, 1, '2850', 74_100_000n, '2850'],
      [2, 2, '3800', 98_800_000n, '3800'],
      [3, 3, '2850', 74_100_000n, '2850'],
    ])
    expect(lines[1]!.description).toContain('งวดที่ 2 (40%)')
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).netSatang).toBe(247_000_000n)
  })

  it('PROCUREMENT only, on a SERVICE draft, a line not split before; FINANCE is refused', async () => {
    const po = await draftServicePo([{ quantity: '1', unitPrice: '1000.00' }])
    expect(await setPoMilestones(fin(ap), { poId: po.id, expectedVersion: po.version, poLineId: po.lines[0]!.id, sharesBp: [5000, 5000] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'GOODS' } })
    expect(await setPoMilestones(proc(), { poId: po.id, expectedVersion: po.version, poLineId: po.lines[0]!.id, sharesBp: [5000, 5000] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_SERVICE' } } })
    const set = ok(await setPoRetention(proc(), { poId: po.id, expectedVersion: po.version, retentionBp: 1000, retentionHoldDays: 180 }, key()))
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ retentionBp: 1000, retentionHoldDays: 180, version: set.version })
  })
})

describe('[FR-AP-106/AC2] [FR-AP-106/AC3] [FR-AP-106/AC4] a milestone invoice with its retention, released and paid', () => {
  let invoiceId: string
  let retentionId: string
  let poId: string
  let lines: Awaited<ReturnType<typeof linesOf>>
  beforeAll(async () => {
    const po = await draftServicePo([{ quantity: '9500', unitPrice: '260.00' }])
    ok(await setPoMilestones(proc(), { poId: po.id, expectedVersion: po.version, poLineId: po.lines[0]!.id, sharesBp: [3000, 4000, 3000] }, key()))
    ok(await submitPo(proc(), { poId: po.id }, key()))
    await ap.flow.approveAll(po.id)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: AP_NOW } })
    poId = po.id
    lines = await linesOf(po.id)
    // milestone 1 is received with the goods receipt of tier 1 (BR-RET-02) and invoiced as a service
    await receive(ap, { id: po.id, lines }, { 0: '2850' })
    const draft = await codedDraft(ap, { id: po.id, lines }, { no: `M1-${randomUUID().slice(0, 6)}`, vat: '51870.00', lines: [{ line: 0, quantity: '2850', unitPrice: '260.00' }] })
    invoiceId = draft.invoiceId
  })

  it('the invoice of milestone 1 is ready with 5% held back: payable and expected tax as GC-RET-05; the retention is HELD with its due date', async () => {
    const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
    expect(ok(await submit(ap, { invoiceId, version })).status).toBe('READY_FOR_PAYMENT')
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ netSatang: 74_100_000n, grossSatang: 79_287_000n, retentionSatang: 3_705_000n, payableSatang: 75_582_000n, expectedWhtSatang: 2_111_850n })
    // transfer when paid alone: 734,701.50
    expect(invoice.payableSatang - invoice.expectedWhtSatang).toBe(73_470_150n)
    const retention = await prisma.retention.findFirstOrThrow({ where: { invoiceId } })
    retentionId = retention.id
    // no due date while milestones are still to come
    expect(retention).toMatchObject({ status: 'HELD', amountSatang: 3_705_000n, releaseDueOn: null })
    await receive(ap, { id: poId, lines }, { 1: '3800' })
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: retentionId } })).releaseDueOn).toBeNull()
    // the last milestone, received at AP_NOW (Thai date 2026-10-12): due 365 days later
    await receive(ap, { id: poId, lines }, { 2: '2850' })
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: retentionId } })).releaseDueOn!.toISOString().slice(0, 10)).toBe('2027-10-12')
  })

  it('released before its day: RETENTION_NOT_DUE; the job tells FINANCE once on the day; FINANCE releases it then', async () => {
    const version = () => prisma.retention.findUniqueOrThrow({ where: { id: retentionId } }).then((r) => r.version)
    expect(await releaseRetention(fin(ap), { retentionId, version: await version() }, key())).toMatchObject({ ok: false, error: { code: 'RETENTION_NOT_DUE', details: { date: '2027-10-12' } } })
    expect(await releaseRetention(ap.org.ctxOf('proc_officer', later(366)), { retentionId, version: await version() }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the job reads every organization (other tests' retentions too): only this retention's events are counted
    const marks = () => prisma.event.count({ where: { aggregateId: retentionId, type: 'retention.release_due' } })
    await markDueRetentions(later(364))
    expect(await marks()).toBe(0)
    await markDueRetentions(later(365))
    expect(await marks()).toBe(1)
    await markDueRetentions(later(366))
    expect(await marks()).toBe(1)
    expect(await prisma.notification.count({ where: { templateKey: 'retention.due', subjectId: retentionId } })).toBeGreaterThan(0)
    ok(await releaseRetention(ap.org.ctxOf('fin_officer', later(365)), { retentionId, version: await version() }, key()))
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: retentionId } })).status).toBe('RELEASABLE')
  })

  it('S9 pays the invoice and its released retention in one item: one 50 ทวิ, the tax split as GC-WHT-21', async () => {
    const run = randomUUID()
    const ctx = s9(later(366))
    expect(await inS9(ctx, (tx) => holdInvoicesForPayment(tx, ctx, { invoiceIds: [invoiceId], paymentRunId: run }))).toMatchObject({ ok: true })
    expect(await inS9(ctx, (tx) => holdRetentionsForPayment(tx, ctx, { retentionIds: [retentionId], paymentRunId: run }))).toMatchObject({ ok: true })
    // let go and taken again: back to RELEASABLE in between
    await inS9(ctx, (tx) => releaseRetentionsFromPayment(tx, ctx, { retentionIds: [retentionId], reason: 'แยกรอบ' }))
    expect((await prisma.retention.findUniqueOrThrow({ where: { id: retentionId } })).status).toBe('RELEASABLE')
    await inS9(ctx, (tx) => holdRetentionsForPayment(tx, ctx, { retentionIds: [retentionId], paymentRunId: run }))
    const paid = await inS9(ctx, (tx) =>
      recordInvoicePayment(tx, ctx, { invoiceIds: [invoiceId], retentionIds: [retentionId], paymentRunItemId: randomUUID(), paidOn: '2027-10-13', whtLines: [{ incomeType: 'CONTRACT', rateBp: 300, baseSatang: 74_100_000n, whtSatang: 2_223_000n }] }),
    )
    if (!paid.ok) throw new Error(JSON.stringify(paid.error))
    const rows = await prisma.withholdingTax.findMany({ where: { certificateId: paid.certificateId! } })
    expect(rows.find((r) => r.invoiceId === invoiceId)!.taxSatang).toBe(2_111_850n)
    expect(rows.find((r) => r.retentionId === retentionId)!.taxSatang).toBe(111_150n)
    expect((await prisma.whtCertificate.findUniqueOrThrow({ where: { id: paid.certificateId! } })).totalTaxSatang).toBe(2_223_000n)
    expect(await prisma.retention.findUniqueOrThrow({ where: { id: retentionId } })).toMatchObject({ status: 'PAID' })
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status).toBe('PAID')
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: retentionId, type: 'retention.paid' } })
    expect(event.data).toMatchObject({ amountSatang: '3705000', whtSatang: '111150', transferSatang: '3593850' })
  })
})

describe('[FR-AP-106/AC5] PAY switched off', () => {
  it('po.setMilestones and retention.release are MODULE_DISABLED', async () => {
    const off = await apOrg({ modules: [] })
    const ctx = off.org.ctxOf('proc_officer', AP_NOW)
    expect(await setPoMilestones(ctx, { poId: randomUUID(), expectedVersion: 0, poLineId: randomUUID(), sharesBp: [5000, 5000] }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await releaseRetention(fin(off), { retentionId: randomUUID(), version: 0 }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})
