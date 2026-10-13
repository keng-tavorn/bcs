import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { listPoInvoices } from '@/server/queries/document-page'
import { createDraftFromReading, createInvoice } from '@/server/services/ap'
import { recordInvoice } from '@/server/services/invoices'
import { setModule } from '@/server/services/modules'
import { closePurchaseOrder } from '@/server/services/purchase-orders'
import { AP_NOW, apOrg, balanceOf, codedDraft, fin, invoiceReading, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-04 (ADR-121, BR-IVC-06, BR-AP-11, BR-AP-03): a PO takes tier-1 confirmations or tier-2 invoices, never both; what
// reads invoices counts tier 2 too (closing a PO, the document page); PAY cannot be switched off under open invoices;
// and S13's way in, a draft from the values an AI read.

let ap: ApOrg
beforeAll(async () => {
  ap = await apOrg()
})

const tier1 = (who: ApOrg, poId: string, no: string) =>
  recordInvoice(fin(who), { poId, invoiceNo: no, invoiceDate: '2026-10-10', net: '1000.00', vat: '70.00', isFinal: false }, key())

describe('[FR-AP-102/AC6] [INV-AP-05] one kind of invoice per PO (BR-IVC-06)', () => {
  it('a PO with a tier-2 invoice takes no tier-1 confirmation', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '2' })
    ok(await createInvoice(fin(ap), { poId: po.id }, key()))
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).invoiceTrack).toBe('MATCHING')
    expect(await tier1(ap, po.id, 'T1-A')).toMatchObject({ ok: false, error: { code: 'INVOICE_TRACK_MISMATCH', details: { track: 'MATCHING' } } })
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
  })

  it('with PAY on, a fresh PO takes tier-2 invoices only', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '2' })
    expect(await tier1(ap, po.id, 'T1-B')).toMatchObject({ ok: false, error: { code: 'INVOICE_TRACK_MISMATCH', details: { track: 'MATCHING' } } })
  })

  it('a PO that took a tier-1 confirmation before keeps that kind: a tier-2 draft is refused', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '1000.00' }])
    await prisma.invoiceConfirmation.create({
      data: { organizationId: ap.org.organizationId, poId: po.id, supplierId: ap.supplierId, invoiceNo: 'OLD-1', invoiceNoNormalized: 'OLD-1', invoiceDate: new Date('2026-09-01'), netSatang: 100_000n, vatSatang: 7_000n, grossSatang: 107_000n, recordedById: ap.org.member.fin_officer!, recordedAt: AP_NOW },
    })
    expect(await createInvoice(fin(ap), { poId: po.id }, key())).toMatchObject({ ok: false, error: { code: 'INVOICE_TRACK_MISMATCH', details: { track: 'CONFIRMATION' } } })
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(0)
  })

  it('without PAY, invoice_confirmation.record works as before and puts the PO on CONFIRMATION', async () => {
    const off = await apOrg({ modules: ['AI', 'BCS_GO'] })
    const po = await sentPo(off, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(off, po, { 0: '2' })
    ok(await tier1(off, po.id, 'T1-C'))
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).invoiceTrack).toBe('CONFIRMATION')
  })
})

describe('[FR-AP-102/AC3] closing a PO counts its tier-2 invoices (BR-AP-11, BR-BUD-06)', () => {
  it('after the last invoice is ready, closing gives back what the PO still held', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '10' })
    // the supplier bills 9 at the PO price as its last invoice: 100.00 is never billed
    ok(await submit(ap, await codedDraft(ap, po, { no: 'CL-1', vat: '63.00', isFinal: true, lines: [{ line: 0, quantity: '9', unitPrice: '100.00' }] })))
    const before = await balanceOf(po.budgetLineId)
    ok(await closePurchaseOrder(ap.org.ctxOf('proc_officer', AP_NOW), { poId: po.id }, key()))
    const after = await balanceOf(po.budgetLineId)
    expect(Number(after.available) - Number(before.available)).toBeCloseTo(100, 2)
    expect((await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: po.lines[0]!.id } })).committedSatang).toBe(0n)
  })

  it('a PO closed after part of it was invoiced keeps only what was received and not yet invoiced', async () => {
    const po = await sentPo(ap, [{ quantity: '10', unitPrice: '100.00' }])
    await receive(ap, po, { 0: '10' })
    ok(await submit(ap, await codedDraft(ap, po, { no: 'CL-2', vat: '42.00', lines: [{ line: 0, quantity: '6', unitPrice: '100.00' }] })))
    ok(await closePurchaseOrder(ap.org.ctxOf('proc_officer', AP_NOW), { poId: po.id }, key()))
    // 1,000.00 received − 600.00 invoiced: 400.00 stays held for the invoice still to come
    expect((await prisma.budgetAllocation.findFirstOrThrow({ where: { sourceType: 'PO_LINE', sourceId: po.lines[0]!.id } })).committedSatang).toBe(40_000n)
  })

  it('the document page lists the PO’s tier-2 invoices', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
    await receive(ap, po, { 0: '1' })
    ok(await submit(ap, await codedDraft(ap, po, { no: 'DOC-1', vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })))
    expect(await listPoInvoices(fin(ap), po.id)).toMatchObject([{ invoiceNo: 'DOC-1', invoiceDate: '2026-10-10', grossSatang: 107_000n, isFinal: false }])
  })
})

describe('[FR-AP-102/AC6] PAY stays on while invoices are open (BR-IVC-06)', () => {
  it('switching PAY off is MODULE_IN_USE and names the open invoices', async () => {
    const own = await apOrg()
    const po = await sentPo(own, [{ quantity: '1', unitPrice: '1000.00' }])
    ok(await createInvoice(fin(own), { poId: po.id }, key()))
    const admin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const platform = makeCtx({ organizationId: own.org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: admin.id }, channel: 'WEB', now: AP_NOW })
    const r = await setModule(platform, { module: 'PAY', enabled: false, contractRef: 'CT-1', reason: 'ทดสอบปิดโมดูล' }, key())
    expect(r).toMatchObject({ ok: false, error: { code: 'MODULE_IN_USE', details: { reason: 'OPEN_DOCUMENTS' } } })
    expect((await prisma.orgModule.findFirstOrThrow({ where: { organizationId: own.org.organizationId, module: 'PAY' } })).enabled).toBe(true)
  })
})

describe('[FR-AP-101/AC5] a draft from what an AI read (invoice.createDraftFromReading, BR-AP-03)', () => {
  const file = async () =>
    (await prisma.fileObject.create({ data: { organizationId: ap.org.organizationId, storageKey: `test/${randomUUID()}.jpg`, fileName: 'invoice.jpg', mimeType: 'image/jpeg', sizeBytes: 1, status: 'AVAILABLE', uploadedById: ap.org.member.fin_officer! } })).id

  it('makes a draft labelled AI_READING by the member who accepted the reading', async () => {
    const po = await sentPo(ap, [{ quantity: '3', unitPrice: '500.00' }])
    const agentActionId = await invoiceReading(ap, po.id)
    const { invoiceId } = ok(
      await createDraftFromReading(fin(ap), { fileId: await file(), poId: po.id, supplierId: ap.supplierId, agentActionId, supplierInvoiceNo: 'AI-77', invoiceDate: '2026-10-09', statedVat: '105.00', lines: [{ poLineId: po.lines[0]!.id, quantity: '3', unitPrice: '500.00' }] }, key()),
    )
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
    expect(invoice).toMatchObject({ status: 'DRAFT', prefill: 'AI_READING', agentActionId, createdById: ap.org.member.fin_officer, supplierInvoiceNo: 'AI-77', netSatang: 150_000n, statedVatSatang: 10_500n, grossSatang: 160_500n })
    expect(invoice.fieldSources).toEqual({ supplierInvoiceNo: 'AI_READING', invoiceDate: 'AI_READING', statedVat: 'AI_READING', lines: 'AI_READING' })
    const drafted = await prisma.event.findFirstOrThrow({ where: { aggregateId: invoiceId, type: 'invoice.drafted' } })
    expect(drafted).toMatchObject({ actorType: 'USER', actorMemberId: ap.org.member.fin_officer, data: { prefill: 'AI_READING', agentActionId } })
  })

  it('[FR-AI-303/AC6] refuses an AI action that is not this PO’s invoice reading, and no draft is made', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    const other = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    const reading = await invoiceReading(ap, po.id)
    const withFile = async (agentActionId: string, aiAssist?: { agentActionId: string; confirmedPaths: string[] }) => createDraftFromReading(fin(ap), { fileId: await file(), poId: po.id, agentActionId, ...(aiAssist ? { aiAssist } : {}) }, key())
    expect(await withFile(randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { field: 'agentActionId' } } })
    expect(await withFile(reading, { agentActionId: randomUUID(), confirmedPaths: [] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AGENT_ACTION_MISMATCH' } } })
    expect(await withFile(await invoiceReading(ap, other.id))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUBJECT_MISMATCH' } } })
    await prisma.agentAction.update({ where: { id: reading }, data: { purpose: 'DELIVERY_NOTE_READ' } })
    expect(await withFile(reading)).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'PURPOSE_MISMATCH' } } })
    expect(await prisma.invoice.count({ where: { poId: po.id } })).toBe(0)
  })

  it('refuses a supplier that is not the PO’s, and is refused without invoice.record', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    const other = await prisma.supplier.create({ data: { organizationId: ap.org.organizationId, code: `S-${randomUUID().slice(0, 6)}`, nameTh: 'อื่น', isForeign: true } })
    expect(await createDraftFromReading(fin(ap), { fileId: await file(), poId: po.id, supplierId: other.id, agentActionId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SUPPLIER_NOT_PO' } } })
    expect(await createDraftFromReading(ap.org.ctxOf('proc_officer', AP_NOW), { fileId: await file(), poId: po.id, agentActionId: randomUUID() }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})
