import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { cancelInvoice, confirmInvoiceCoding, createInvoice, submitInvoice, updateInvoice } from '@/server/services/ap'
import { closePurchaseOrder } from '@/server/services/purchase-orders'
import { AP_NOW, apOrg, balanceOf, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-03 (docs/sub-specs/S8.md, spec §7.14 BR-MATCH, §7.18 BR-AP): tier-2 invoices through the real services on
// Postgres — matched, over within and beyond the tolerance, short, duplicate, a service, two invoices at once on one
// PO line, the last invoice of a closed PO, and the checks before submit. Golden cases of the engine are in
// tests/golden/matching.test.ts; these check what the service reads and writes around it.

let ap: ApOrg
beforeAll(async () => {
  ap = await apOrg()
})

const exceptionsOf = (invoiceId: string) => prisma.matchException.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' }, select: { type: true, amountSatang: true, quantity: true, assigneeRole: true, status: true } })

describe('[FR-AP-102/AC3] a matched invoice is ready for payment with its ledger', () => {
  it('goods matched three ways: READY_FOR_PAYMENT, COMMITTED → ACTUAL, due date, one InvoiceMatch with the policy', async () => {
    const po = await sentPo(ap, [{ quantity: '9', unitPrice: '2863.00' }])
    await receive(ap, po, { 0: '9' })
    const before = await balanceOf(po.budgetLineId)
    const draft = await codedDraft(ap, po, { no: 'IV 000496', vat: '1803.69', lines: [{ line: 0, quantity: '9', unitPrice: '2863.00' }] })
    const r = ok(await submit(ap, draft))
    expect(r).toMatchObject({ status: 'READY_FOR_PAYMENT', exceptions: [] })
    expect(r.number).toMatch(/^AP-2569-\d{5}$/)
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })
    expect(inv).toMatchObject({ status: 'READY_FOR_PAYMENT', netSatang: 2_576_700n, statedVatSatang: 180_369n, grossSatang: 2_757_069n, payableSatang: 2_757_069n, matchResult: 'MATCHED', recordedById: ap.org.member.fin_officer })
    // BR-AP-07: the supplier and the PO give no credit days here, so settings.ap.defaultTermDays (OQ-129: 30)
    expect(inv.dueDate?.toISOString().slice(0, 10)).toBe('2026-11-09')
    const after = await balanceOf(po.budgetLineId)
    expect(Number(after.committed)).toBeCloseTo(Number(before.committed) - 25_767, 2)
    expect(Number(after.actual)).toBeCloseTo(Number(before.actual) + 25_767, 2)
    const match = await prisma.invoiceMatch.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
    expect(match).toMatchObject({ runNo: 1, result: 'MATCHED', triggeredBy: 'USER', policy: { priceTolBp: 100, priceTolAmount: '1000.00', qtyTolBp: 0, vatTolAmount: '1.00', vatRateBp: 700 } })
    const events = await prisma.event.findMany({ where: { aggregateId: draft.invoiceId }, select: { type: true } })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['invoice.drafted', 'invoice.updated', 'invoice.coding_confirmed', 'invoice.submitted', 'invoice.matched', 'invoice.ready']))
    expect(await prisma.event.count({ where: { type: 'budget.actualized', data: { path: ['documentId'], equals: po.id } } })).toBe(1)
  })

  it('[FR-AP-102/AC1] a price over within the tolerance holds what the line lacks, then moves it all to ACTUAL (GC-MATCH-02)', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '23500.00' }])
    await receive(ap, po, { 0: '1' })
    const before = await balanceOf(po.budgetLineId)
    const draft = await codedDraft(ap, po, { no: 'W-0001', vat: '1653.23', lines: [{ line: 0, quantity: '1', unitPrice: '23617.50' }] })
    expect(ok(await submit(ap, draft)).status).toBe('READY_FOR_PAYMENT')
    const after = await balanceOf(po.budgetLineId)
    // 117.50 more held from AVAILABLE, then 23,617.50 to ACTUAL: the PO line's commitment is used up exactly
    expect(Number(before.available) - Number(after.available)).toBeCloseTo(117.5, 2)
    expect(Number(after.actual) - Number(before.actual)).toBeCloseTo(23_617.5, 2)
    expect((await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: po.lines[0]!.id } })).committedSatang).toBe(0n)
    expect((await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })).flags).toEqual(['PRICE_OVER_WITHIN'])
  })
})

describe('[FR-AP-102/AC1] differences become exceptions and move no money', () => {
  it('a price over beyond the tolerance is PRICE_OVER for PROCUREMENT (GC-MATCH-07)', async () => {
    const po = await sentPo(ap, [{ quantity: '20000', unitPrice: '32.50' }])
    await receive(ap, po, { 0: '20000' })
    const before = await balanceOf(po.budgetLineId)
    const draft = await codedDraft(ap, po, { no: 'DS-1', vat: '46872.00', lines: [{ line: 0, quantity: '20000', unitPrice: '33.48' }] })
    expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION', exceptions: [{ type: 'PRICE_OVER', amount: '19600.00', lineNo: 1 }] })
    expect(await exceptionsOf(draft.invoiceId)).toMatchObject([{ type: 'PRICE_OVER', amountSatang: 1_960_000n, assigneeRole: 'PROCUREMENT', status: 'OPEN' }])
    expect(await balanceOf(po.budgetLineId)).toEqual(before)
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).toMatchObject({ status: 'EXCEPTION', matchResult: 'EXCEPTION', dueDate: null })
  })

  it('invoiced beyond what was received is QTY_NOT_RECEIVED for the receiver (GC-MATCH-08)', async () => {
    const po = await sentPo(ap, [{ quantity: '100', unitPrice: '240.00' }])
    await receive(ap, po, { 0: '90' })
    const draft = await codedDraft(ap, po, { no: 'Q-1', vat: '1680.00', lines: [{ line: 0, quantity: '100', unitPrice: '240.00' }] })
    expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION', exceptions: [{ type: 'QTY_NOT_RECEIVED', amount: '2400.00', lineNo: 1 }] })
    expect(await exceptionsOf(draft.invoiceId)).toMatchObject([{ type: 'QTY_NOT_RECEIVED', assigneeRole: 'RECEIVER' }])
    expect((await exceptionsOf(draft.invoiceId))[0]!.quantity?.toString()).toBe('10')
  })

  it('a VAT more than 1.00 baht away from the computed one is VAT_MISMATCH for FINANCE (BR-VAT-05)', async () => {
    const po = await sentPo(ap, [{ quantity: '9', unitPrice: '2863.00' }])
    await receive(ap, po, { 0: '9' })
    const draft = await codedDraft(ap, po, { no: 'V-1', vat: '1804.70', lines: [{ line: 0, quantity: '9', unitPrice: '2863.00' }] })
    expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION', exceptions: [{ type: 'VAT_MISMATCH', amount: '1.01', lineNo: null }] })
    expect(await exceptionsOf(draft.invoiceId)).toMatchObject([{ assigneeRole: 'FINANCE' }])
  })
})

describe('[FR-AP-105/AC1] duplicates', () => {
  it('the same supplier number again is DUPLICATE_INVOICE at submit and nothing is written; a draft may carry it', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '2' })
    ok(await submit(ap, await codedDraft(ap, po, { no: 'บก.000583', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })))
    const again = await codedDraft(ap, po, { no: ' บก. 000583', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(await submit(ap, again)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_INVOICE', details: { invoiceNo: 'บก.000583' } } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: again.invoiceId } })).toMatchObject({ status: 'DRAFT', number: null })
    expect(await prisma.invoiceMatch.count({ where: { invoiceId: again.invoiceId } })).toBe(0)
  })

  it('a tier-1 confirmation of the same number counts too (INV-AP-06)', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const other = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    await prisma.invoiceConfirmation.create({
      data: { organizationId: ap.org.organizationId, poId: other.id, supplierId: ap.supplierId, invoiceNo: 'T1-77', invoiceNoNormalized: 'T1-77', invoiceDate: new Date('2026-10-01'), netSatang: 50_000n, vatSatang: 3_500n, grossSatang: 53_500n, recordedById: ap.org.member.fin_officer!, recordedAt: AP_NOW },
    })
    const draft = await codedDraft(ap, po, { no: 't1-77', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(await submit(ap, draft)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_INVOICE' } })
  })

  it('another number with the same total within 3 days is POSSIBLE_DUPLICATE for FINANCE (GC-MATCH-23)', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '2' })
    ok(await submit(ap, await codedDraft(ap, po, { no: 'PD-1', date: '2026-10-08', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })))
    const second = await codedDraft(ap, po, { no: 'PD-2', date: '2026-10-10', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(ok(await submit(ap, second))).toMatchObject({ status: 'EXCEPTION', exceptions: [{ type: 'POSSIBLE_DUPLICATE', amount: '1070.00' }] })
  })
})

describe('[FR-AP-102/AC4] services match two ways against the work confirmed', () => {
  it('confirmed work matches (GC-MATCH-12); work not yet confirmed is ACCEPTANCE_PENDING (GC-MATCH-13)', async () => {
    const po = await sentPo(ap, [{ quantity: '24', unitPrice: '18500.00' }])
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'SERVICE' } })
    const early = await codedDraft(ap, po, { no: 'SV-1', vat: '31080.00', lines: [{ line: 0, quantity: '24', unitPrice: '18500.00' }] })
    expect(ok(await submit(ap, early))).toMatchObject({ status: 'EXCEPTION', exceptions: [{ type: 'ACCEPTANCE_PENDING', amount: '444000.00' }] })
    await receive(ap, po, { 0: '24' })
    const later = await codedDraft(ap, po, { no: 'SV-2', date: '2026-10-05', vat: '31080.00', lines: [{ line: 0, quantity: '24', unitPrice: '18500.00' }] })
    expect(ok(await submit(ap, later)).status).toBe('READY_FOR_PAYMENT')
  })
})

describe('[FR-AP-102/AC5] [INV-AP-01] two invoices at once on one PO line received for one', () => {
  it('one is ready for payment, the other QTY_NOT_RECEIVED', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '6' })
    const a = await codedDraft(ap, po, { no: 'C-A', vat: '42.00', lines: [{ line: 0, quantity: '6', unitPrice: '100.00' }] })
    const b = await codedDraft(ap, po, { no: 'C-B', date: '2026-10-05', vat: '42.00', lines: [{ line: 0, quantity: '6', unitPrice: '100.00' }] }, 'dm_fin')
    const [ra, rb] = await Promise.all([submit(ap, a), submit(ap, b, 'dm_fin')])
    const statuses = [ok(ra).status, ok(rb).status].sort()
    expect(statuses).toEqual(['EXCEPTION', 'READY_FOR_PAYMENT'])
    const blocked = ok(ra).status === 'EXCEPTION' ? a : b
    expect(await exceptionsOf(blocked.invoiceId)).toMatchObject([{ type: 'QTY_NOT_RECEIVED' }])
    expect((await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: po.lines[0]!.id } })).actualSatang).toBe(60_000n)
  })
})

describe('[FR-AP-102/AC3] the last invoice of a closed PO gives back what the PO still held (BR-BUD-06)', () => {
  it('a final invoice below the PO price on a closed PO releases the rest (GC-MATCH-16)', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '10' })
    ok(await closePurchaseOrder(ap.org.ctxOf('proc_officer', AP_NOW), { poId: po.id }, key()))
    const before = await balanceOf(po.budgetLineId)
    const draft = await codedDraft(ap, po, { no: 'F-1', vat: '68.60', isFinal: true, lines: [{ line: 0, quantity: '10', unitPrice: '98.00' }] })
    expect(ok(await submit(ap, draft)).status).toBe('READY_FOR_PAYMENT')
    const after = await balanceOf(po.budgetLineId)
    expect(Number(after.actual) - Number(before.actual)).toBeCloseTo(980, 2)
    expect(Number(after.available) - Number(before.available)).toBeCloseTo(20, 2)
    expect((await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: po.lines[0]!.id } })).committedSatang).toBe(0n)
  })
})

describe('[FR-AP-108/AC2] the checks before submit', () => {
  it('a line whose account code is not confirmed is CODING_NOT_CONFIRMED', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const ctx = fin(ap)
    const { invoiceId } = ok(await createInvoice(ctx, { poId: po.id }, key()))
    const v0 = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
    const { version } = ok(await updateInvoice(ctx, { invoiceId, version: v0, supplierInvoiceNo: 'NC-1', invoiceDate: '2026-10-10', statedVat: '70.00' }, key()))
    expect(await submitInvoice(ctx, { invoiceId, version }, key())).toMatchObject({ ok: false, error: { code: 'CODING_NOT_CONFIRMED', details: { lines: '1' } } })
  })

  it('an account code that is not active, and another cost center without a reason, are VALIDATION_FAILED', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    const ctx = fin(ap)
    const { invoiceId } = ok(await createInvoice(ctx, { poId: po.id }, key()))
    const line = await prisma.invoiceLine.findFirst({ where: { invoiceId } })
    const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
    // nothing received yet: the draft has no line to code, so make one
    const { version: v1 } = line ? { version } : ok(await updateInvoice(ctx, { invoiceId, version, lines: [{ poLineId: po.lines[0]!.id, quantity: '1', unitPrice: '1000.00' }] }, key()))
    const l = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId }, include: { poLine: { include: { budgetLine: true } } } })
    const other = await prisma.costCenter.findFirstOrThrow({ where: { organizationId: ap.org.organizationId, id: { not: l.poLine.budgetLine.costCenterId } } })
    expect(await confirmInvoiceCoding(ctx, { invoiceId, version: v1, lines: [{ invoiceLineId: l.id, accountCode: '599999', costCenterId: l.poLine.budgetLine.costCenterId }] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'ACCOUNT_CODE_UNKNOWN' } } })
    expect(await confirmInvoiceCoding(ctx, { invoiceId, version: v1, lines: [{ invoiceLineId: l.id, accountCode: '530101', costCenterId: other.id }] }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'COST_CENTER_REASON_REQUIRED' } } })
    const done = ok(await confirmInvoiceCoding(ctx, { invoiceId, version: v1, lines: [{ invoiceLineId: l.id, accountCode: '530101', costCenterId: other.id, costCenterReason: 'ใช้ที่ไซต์อื่น' }] }, key()))
    expect(await prisma.invoiceLine.findUniqueOrThrow({ where: { id: l.id } })).toMatchObject({ accountCode: '530101', costCenterId: other.id, codingSource: 'MANUAL', costCenterReason: 'ใช้ที่ไซต์อื่น' })
    expect(done.version).toBe(v1 + 1)
  })

  it('[FR-AP-101/AC6] a draft moves no money and is thrown away with a reason', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const before = await balanceOf(po.budgetLineId)
    const draft = await codedDraft(ap, po, { no: 'X-1', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(await balanceOf(po.budgetLineId)).toEqual(before)
    ok(await cancelInvoice(fin(ap), { ...draft, reason: 'ผู้ขายส่งผิดใบ' }, key()))
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'ผู้ขายส่งผิดใบ' })
    expect(await submit(ap, { invoiceId: draft.invoiceId, version: draft.version + 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('[FR-AP-105/AC5] whoever created the PO or received its goods does not record its invoice (BR-AP-05)', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    await prisma.roleAssignment.create({ data: { organizationId: ap.org.organizationId, memberId: ap.org.member.receiver_con!, role: 'FINANCE', grantedAt: AP_NOW } })
    const draft = await codedDraft(ap, po, { no: 'SOD-1', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] }, 'receiver_con')
    expect(await submit(ap, draft, 'receiver_con')).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-AP-05', reason: 'GR_RECEIVER' } } })
    expect(await prisma.event.count({ where: { type: 'security.sod_blocked', aggregateId: draft.invoiceId } })).toBe(1)
    await prisma.roleAssignment.updateMany({ where: { memberId: ap.org.member.receiver_con!, role: 'FINANCE' }, data: { revokedAt: AP_NOW } })
  })

  it('an invoice dated after today, or without a date or number, is VALIDATION_FAILED', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: 'D-1', date: '2026-10-13', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(await submit(ap, draft)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'IN_THE_FUTURE' } } })
  })

  it('a version the screen read before a change is CONFLICT_VERSION', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: 'CV-1', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
    expect(await submit(ap, { invoiceId: draft.invoiceId, version: draft.version - 1 })).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
  })
})

describe('[FR-AP-101/AC1] the draft from the PO', () => {
  it('fills the lines still to invoice at the PO price, and an update keeps a line’s coding', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }, { quantity: '5', unitPrice: '2000.00' }])
    await receive(ap, po, { 0: '6' })
    const { invoiceId, prefill } = ok(await createInvoice(fin(ap), { poId: po.id }, key()))
    expect(prefill).toBe('MANUAL')
    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId }, orderBy: { lineNo: 'asc' } })
    expect(lines.map((l) => [l.poLineId, l.quantity.toString(), l.unitPriceSatang])).toEqual([[po.lines[0]!.id, '6', 10_000n]])
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({ status: 'DRAFT', netSatang: 60_000n, channel: 'UPLOAD', createdById: ap.org.member.fin_officer })
  })

  it('[FR-AP-101/AC5] an update with aiAssist is MODULE_DISABLED until S13 and the draft does not change', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, key()))
    const before = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    const r = await updateInvoice(fin(ap), { invoiceId, version: before.version, supplierInvoiceNo: 'AI-1', aiAssist: { agentActionId: '0199a000-0000-7000-8000-000000000001', confirmedPaths: ['supplierInvoiceNo'] } }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED', details: { module: 'AI' } } })
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).toEqual(before)
  })
})

describe('S8-05 review fixes', () => {
  it('an edit of the lines keeps a PO line that is not VAT-able so', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await prisma.poLine.update({ where: { id: po.lines[0]!.id }, data: { vatable: false } })
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, key()))
    const v = (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
    ok(await updateInvoice(fin(ap), { invoiceId, version: v, lines: [{ poLineId: po.lines[0]!.id, quantity: '1', unitPrice: '1000.00' }] }, key()))
    expect((await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId } })).vatable).toBe(false)
  })

  it('[INV-AP-06] the same supplier number submitted at once on two POs: one passes, the other is DUPLICATE_INVOICE', async () => {
    const [p1, p2] = [await sentPo(ap, [{ quantity: '1', unitPrice: '700.00' }]), await sentPo(ap, [{ quantity: '1', unitPrice: '800.00' }])]
    await receive(ap, p1, { 0: '1' })
    await receive(ap, p2, { 0: '1' })
    const a = await codedDraft(ap, p1, { no: 'SAME-1', vat: '49.00', lines: [{ line: 0, quantity: '1', unitPrice: '700.00' }] })
    const b = await codedDraft(ap, p2, { no: 'SAME-1', vat: '56.00', lines: [{ line: 0, quantity: '1', unitPrice: '800.00' }] }, 'dm_fin')
    const results = await Promise.all([submit(ap, a), submit(ap, b, 'dm_fin')])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: 'DUPLICATE_INVOICE' } })
  })
})
