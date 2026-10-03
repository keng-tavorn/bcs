import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { fund } from '@/core/budget'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { vatFromNet } from '@/core/money/math'
import { applyBudget } from '@/server/budget/ledger'
import { systemCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { decideTask } from '@/server/services/approvals/decide'
import { readEtaxFile, recordInvoice } from '@/server/services/invoices'
import { assignSupplier, consolidateNow } from '@/server/services/procurement'
import { closePurchaseOrder, editDraftPo, submitPo } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { createDraft, submitRequest } from '@/server/services/requests'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { etaxXml, pdfWithEmbedded } from '../support/etax-files'

// S4-08 (spec §7.12, BR-IVC-01 to BR-IVC-04, FR-P2P-008 AC1–AC3): FINANCE records the supplier's invoices against the
// PO; the amount before VAT is shared over the PO lines by what each still holds and moves from committed to actual;
// it never exceeds what the PO holds, the same number twice is refused, and the last invoice lets the PO give back what
// it still held (GC-IVC-01 to GC-IVC-05 and GC-BUD-05 through the services). S4-17 (BR-IVC-05, FR-P2P-008 AC4): an
// e-Tax file the tests make themselves fills the form, or says why it cannot.

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
const fin = () => org.ctxOf('fin_officer', NOW)

beforeAll(async () => {
  org = await createDoaOrg()
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายหนึ่ง', taxId: '0999999000012' } })).id
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW },
    ],
  })
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
  return { available: baht(b.availableSatang), reserved: baht(b.reservedSatang), committed: baht(b.committedSatang), actual: baht(b.actualSatang) }
}

async function approveAll(subjectId: string) {
  for (let i = 0; i < 5; i++) {
    const task = await prisma.approvalTask.findFirst({ where: { status: 'OPEN', step: { route: { subjectId } } } })
    if (!task) return
    ok(await decideTask(org.ctxOf(codeOf(task.assigneeMemberId), NOW), { taskId: task.id, decision: 'APPROVE' }, key()))
  }
}

/** An approved request on `budgetLineId` with these lines, and the quotations ATT-QUOTES needs above 100,000 */
async function approvedRequest(budgetLineId: string, lines: Array<{ quantity: string; unitPrice: string }>) {
  const draft = ok(await createDraft(org.ctxOf('req_con', NOW), { requestTypeCode: 'BUY_GOODS', title: 'วัสดุ', budgetLineId, lines: lines.map((l, i) => ({ description: `ของ ${i + 1}`, quantity: l.quantity, uom: 'ชิ้น', unitPrice: l.unitPrice })) }, key()))
  for (let i = 0; i < 3; i++) {
    const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'q.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'Request', subjectId: draft.requestId, kind: 'QUOTATION' } })
  }
  ok(await submitRequest(org.ctxOf('req_con', NOW), { requestId: draft.requestId }, key()))
  await approveAll(draft.requestId)
  return prisma.request.findUniqueOrThrow({ where: { id: draft.requestId }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
}

/** The requests' lines on one sent PO (a site of their own), with prices changed first when asked */
async function sentPo(requestLineIds: string[], prices: Record<number, string> = {}) {
  const site = await prisma.deliverySite.create({ data: { organizationId: org.organizationId, code: `SITE-${randomUUID().slice(0, 8)}`, nameTh: 'ไซต์' } })
  await prisma.request.updateMany({ where: { lines: { some: { id: { in: requestLineIds } } } }, data: { deliverySiteId: site.id } })
  ok(await assignSupplier(proc(), { requestLineIds, supplierId }, key()))
  const run = ok(await consolidateNow(proc(), key()))
  let po = await prisma.purchaseOrder.findFirstOrThrow({ where: { id: { in: [...run.purchaseOrderIds] }, deliverySiteId: site.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  if (Object.keys(prices).length) {
    ok(await editDraftPo(proc(), { poId: po.id, expectedVersion: po.version, lines: Object.entries(prices).map(([i, unitPrice]) => ({ poLineId: po.lines[Number(i)]!.id, unitPrice })) }, key()))
  }
  ok(await submitPo(proc(), { poId: po.id }, key()))
  await approveAll(po.id)
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
  po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  return po
}

/** An invoice of `net` before VAT with the VAT of the PO's 7 % unless given */
const invoice = (poId: string, invoiceNo: string, net: string, extra: { vat?: string; isFinal?: boolean } = {}) =>
  recordInvoice(fin(), { poId, invoiceNo, invoiceDate: '2026-10-05', net, vat: extra.vat ?? satangToAmount(vatFromNet(amountToSatang(net), 700).vat), isFinal: extra.isFinal ?? false }, key())

describe('[FR-P2P-008/AC1] invoices against what the PO holds, through the service (GC-IVC-01 to GC-IVC-05)', () => {
  it('GC-IVC-01 and GC-IVC-03: invoices up to what the PO holds pass, one satang more is refused', async () => {
    const line = await fundedLine(500_000n)
    const pr = await approvedRequest(line, [{ quantity: '1', unitPrice: '115000.00' }])
    const po = await sentPo([pr.lines[0]!.id])
    ok(await invoice(po.id, 'A1', '60000.00'))
    ok(await invoice(po.id, 'A2', '55000.00'))
    expect(await invoice(po.id, 'A3', '0.01')).toMatchObject({ ok: false, error: { code: 'INVOICE_EXCEEDS_COMMITTED', details: { remaining: '0.00' } } })
    expect(await balance(line)).toMatchObject({ committed: '0.00', actual: '115000.00' })
  })

  it('GC-IVC-02: an invoice above what the PO holds changes nothing', async () => {
    const line = await fundedLine(500_000n)
    const pr = await approvedRequest(line, [{ quantity: '1', unitPrice: '115000.00' }])
    const po = await sentPo([pr.lines[0]!.id])
    const before = await balance(line)
    expect(await invoice(po.id, 'INV-002', '116000.00')).toMatchObject({ ok: false, error: { code: 'INVOICE_EXCEEDS_COMMITTED', details: { remaining: '115000.00' } } })
    expect(await balance(line)).toEqual(before)
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
  })

  it('GC-IVC-04: the same number again from the supplier, written another way, is refused', async () => {
    const line = await fundedLine(500_000n)
    const first = await sentPo([(await approvedRequest(line, [{ quantity: '1', unitPrice: '50000.00' }])).lines[0]!.id])
    ok(await invoice(first.id, 'INV001', '1000.00'))
    const second = await sentPo([(await approvedRequest(line, [{ quantity: '1', unitPrice: '50000.00' }])).lines[0]!.id])
    expect(await invoice(second.id, ' inv 001', '1000.00')).toMatchObject({ ok: false, error: { code: 'DUPLICATE_INVOICE', details: { invoiceNo: 'INV001' } } })
  })

  it('GC-IVC-05: shares the amount over the PO lines by what each holds, largest remainder', async () => {
    const line = await fundedLine(500_000n)
    const pr = await approvedRequest(line, [
      { quantity: '1', unitPrice: '3333.33' },
      { quantity: '1', unitPrice: '6666.67' },
    ])
    const po = await sentPo(pr.lines.map((l) => l.id))
    const recorded = ok(await invoice(po.id, 'B1', '1000.00'))
    expect(recorded.allocation).toEqual([
      { poLineId: po.lines[0]!.id, net: '333.33' },
      { poLineId: po.lines[1]!.id, net: '666.67' },
    ])
    expect(await prisma.invoiceLineAllocation.findMany({ where: { invoiceId: recorded.invoiceId }, orderBy: { netSatang: 'asc' }, select: { netSatang: true } })).toEqual([{ netSatang: 33_333n }, { netSatang: 66_667n }])
  })
})

describe('[FR-P2P-008/AC2] an invoice moves committed to actual on each budget line', () => {
  it('moves each PO line on its own budget line, with a budget.actualized event each', async () => {
    const lineA = await fundedLine(100_000n)
    const lineB = await fundedLine(100_000n)
    const a = await approvedRequest(lineA, [{ quantity: '1', unitPrice: '4000.00' }])
    const b = await approvedRequest(lineB, [{ quantity: '1', unitPrice: '6000.00' }])
    const po = await sentPo([a.lines[0]!.id, b.lines[0]!.id])
    ok(await invoice(po.id, 'C-77', '5000.00'))
    expect(await balance(lineA)).toMatchObject({ committed: '2000.00', actual: '2000.00' })
    expect(await balance(lineB)).toMatchObject({ committed: '3000.00', actual: '3000.00' })
    expect(await prisma.event.count({ where: { type: 'budget.actualized', aggregateId: { in: [lineA, lineB] }, data: { path: ['documentId'], equals: po.id } } })).toBe(2)
  })

  it('warns when the VAT is more than 1.00 away from the PO rate, without refusing', async () => {
    const line = await fundedLine(100_000n)
    const po = await sentPo([(await approvedRequest(line, [{ quantity: '1', unitPrice: '1000.00' }])).lines[0]!.id])
    expect(ok(await invoice(po.id, 'V-1', '500.00', { vat: '35.00' })).vatWarning).toBeNull()
    expect(ok(await invoice(po.id, 'V-2', '100.00', { vat: '9.01' })).vatWarning).toEqual({ expected: '7.00', given: '9.01' })
  })

  it('only FINANCE records invoices, on a PO that was sent', async () => {
    const line = await fundedLine(100_000n)
    const po = await sentPo([(await approvedRequest(line, [{ quantity: '1', unitPrice: '1000.00' }])).lines[0]!.id])
    for (const who of ['proc_officer', 'req_con', 'coo']) {
      expect(await recordInvoice(org.ctxOf(who, NOW), { poId: po.id, invoiceNo: 'X1', invoiceDate: '2026-10-05', net: '1.00', vat: '0.07' }, key()), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'APPROVED' } })
    expect(await invoice(po.id, 'X2', '1.00')).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })
})

describe('[FR-P2P-008/AC3] the last invoice lets the PO give back what it still held (GC-BUD-05, BR-BUD-06)', () => {
  it('GC-BUD-05: 110,000 invoiced on a PO of 115,000, last; closing the PO gives back 5,000', async () => {
    const line = await fundedLine(500_000n)
    const pr = await approvedRequest(line, [{ quantity: '1', unitPrice: '120000.00' }])
    const po = await sentPo([pr.lines[0]!.id], { 0: '115000.00' })
    expect(await balance(line)).toEqual({ available: '385000.00', reserved: '0.00', committed: '115000.00', actual: '0.00' })
    ok(await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '1' }] }, key()))
    ok(await invoice(po.id, 'INV-110', '110000.00', { isFinal: true }))
    expect(await balance(line)).toEqual({ available: '385000.00', reserved: '0.00', committed: '5000.00', actual: '110000.00' })
    ok(await closePurchaseOrder(proc(), { poId: po.id }, key()))
    expect(await balance(line)).toEqual({ available: '390000.00', reserved: '0.00', committed: '0.00', actual: '110000.00' })
    expect(await invoice(po.id, 'INV-111', '1.00')).toMatchObject({ ok: false, error: { details: { reason: 'FINAL_RECORDED' } } })
  })

  it('a PO closed before its invoice keeps the received part; the last invoice gives back what is left', async () => {
    const line = await fundedLine(100_000n)
    const po = await sentPo([(await approvedRequest(line, [{ quantity: '2', unitPrice: '500.00' }])).lines[0]!.id])
    ok(await postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId: po.id, lines: [{ poLineId: po.lines[0]!.id, received: '2' }] }, key()))
    ok(await closePurchaseOrder(proc(), { poId: po.id }, key()))
    expect(await balance(line)).toMatchObject({ committed: '1000.00', actual: '0.00' })
    ok(await invoice(po.id, 'LATE-1', '900.00', { isFinal: true }))
    expect(await balance(line)).toEqual({ available: '99100.00', reserved: '0.00', committed: '0.00', actual: '900.00' })
  })
})

describe('[FR-P2P-008/AC4] an e-Tax file fills the invoice form for FINANCE to confirm (BR-IVC-05)', () => {
  const bytes = (text: string) => new TextEncoder().encode(text)
  const read = (poId: string, fileName: string, content: string | Uint8Array, who = fin()) => readEtaxFile(who, { poId, fileName, content: typeof content === 'string' ? bytes(content) : content })
  const sentPoOf = async (unitPrice: string) => sentPo([(await approvedRequest(await fundedLine(100_000n), [{ quantity: '1', unitPrice }])).lines[0]!.id])

  let sharedPoId: string
  beforeAll(async () => {
    sharedPoId = (await sentPoOf('20000.00')).id
  })

  it('a PDF/A-3 with its XML: the values fill the form, the file is kept, and the confirmation links it as ETAX', async () => {
    const po = await sentPoOf('20000.00')
    // the XML among other embedded files, under a name that says nothing about it
    const pdf = pdfWithEmbedded([
      { name: 'logo.txt', content: 'not xml' },
      { name: 'attachment-1', content: etaxXml({ invoiceNo: 'ET-PDF-1', sellerRegistration: '099999900001200001' }) },
    ])
    const reading = ok(await read(po.id, 'ใบกำกับ ET-PDF-1.pdf', pdf))
    expect(reading).toEqual({
      fileId: expect.any(String),
      problems: [],
      prefill: { invoiceNo: 'ET-PDF-1', invoiceDate: '2026-10-05', net: '10000.00', vat: '700.00', gross: '10700.00', sellerTaxId: '0999999000012', sellerBranch: '00001' },
    })
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: reading.fileId } })).toMatchObject({ fileName: 'ใบกำกับ ET-PDF-1.pdf', mimeType: 'application/pdf', sizeBytes: pdf.length, uploadedById: org.member.fin_officer, status: 'AVAILABLE' })
    expect(await prisma.event.count({ where: { type: 'file.uploaded', aggregateId: reading.fileId } })).toBe(1)

    // FINANCE confirms what was read; it goes through BR-IVC-01 to BR-IVC-04 like a typed invoice
    const p = reading.prefill!
    const recorded = ok(await recordInvoice(fin(), { poId: po.id, invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, net: p.net, vat: p.vat, sourceFileId: reading.fileId, parsedFrom: 'ETAX_XML' }, key()))
    expect(await prisma.fileLink.findMany({ where: { subjectId: recorded.invoiceId }, select: { fileId: true, kind: true, subjectType: true } })).toEqual([{ fileId: reading.fileId, kind: 'ETAX', subjectType: 'InvoiceConfirmation' }])
    expect(await prisma.invoiceConfirmation.findUniqueOrThrow({ where: { id: recorded.invoiceId } })).toMatchObject({ parsedFrom: 'ETAX_XML', sourceFileId: reading.fileId, netSatang: 1_000_000n, vatSatang: 70_000n })
    expect(await read(po.id, 'again.pdf', pdf).then(async (r) => recordInvoice(fin(), { poId: po.id, invoiceNo: p.invoiceNo, invoiceDate: p.invoiceDate, net: p.net, vat: p.vat, sourceFileId: ok(r).fileId, parsedFrom: 'ETAX_XML' }, key()))).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_INVOICE' },
    })
  })

  it('a plain XML file from the full e-Tax system fills the form the same way', async () => {
    const xml = etaxXml({ invoiceNo: 'ET-XML-1', typeCode: 'T02', issueDate: '20261006', sellerRegistration: '0-9999-99000-01-2', net: '1500.5', vat: '105.0400', gross: '1605.54' })
    const reading = ok(await read(sharedPoId, 'ET-XML-1.xml', xml))
    expect(reading).toEqual({
      fileId: expect.any(String),
      problems: [],
      prefill: { invoiceNo: 'ET-XML-1', invoiceDate: '2026-10-06', net: '1500.50', vat: '105.04', gross: '1605.54', sellerTaxId: '0999999000012', sellerBranch: null },
    })
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: reading.fileId }, select: { mimeType: true } })).toEqual({ mimeType: 'application/xml' })
  })

  it('a seller tax id that is not the PO supplier: the reason, no values, and the file is still kept', async () => {
    const reading = ok(await read(sharedPoId, 'other-seller.pdf', pdfWithEmbedded([{ name: 'x.xml', content: etaxXml({ sellerRegistration: '010555512345600000' }) }])))
    expect(reading).toEqual({ fileId: expect.any(String), prefill: null, problems: ['TAX_ID_MISMATCH'] })
    expect(await prisma.fileObject.count({ where: { id: reading.fileId, status: 'AVAILABLE' } })).toBe(1)
  })

  it.each([
    ['a broken XML file', 'broken.xml', () => bytes(etaxXml().replace('</ram:ID>', '')), 'XML_UNREADABLE'],
    ['a PDF whose XML is cut short', 'broken.pdf', () => pdfWithEmbedded([{ name: 'x.xml', content: etaxXml().slice(0, 300) }]), 'XML_UNREADABLE'],
    ['a PDF with no embedded file (a scan)', 'scan.pdf', () => pdfWithEmbedded([]), 'NOT_AN_ETAX_INVOICE'],
    ['an XML file that is not an invoice', 'order.xml', () => bytes('<Order><ID>1</ID></Order>'), 'NOT_AN_ETAX_INVOICE'],
    ['a credit note', 'credit-note.xml', () => bytes(etaxXml({ typeCode: '81' })), 'NOT_AN_ETAX_INVOICE'],
    ['an invoice without its VAT', 'no-vat.xml', () => bytes(etaxXml({ vat: '' })), 'VALUE_MISSING'],
    ['an invoice dated on a day that does not exist', 'bad-date.xml', () => bytes(etaxXml({ issueDate: '2026-02-30T00:00:00' })), 'VALUE_MISSING'],
    ['an amount finer than a satang', 'satang.xml', () => bytes(etaxXml({ net: '10000.005' })), 'VALUE_MISSING'],
    ['a seller registration of the wrong length', 'short-id.xml', () => bytes(etaxXml({ sellerRegistration: '099999900001234' })), 'VALUE_MISSING'],
  ])('%s: the reason, so FINANCE fills the form by hand', async (_, fileName, content, problem) => {
    expect(ok(await read(sharedPoId, fileName, content()))).toEqual({ fileId: expect.any(String), prefill: null, problems: [problem] })
  })

  it('only FINANCE reads e-Tax files, for a PO that exists, and only PDF or XML', async () => {
    for (const who of ['proc_officer', 'req_con']) {
      expect(await read(sharedPoId, 'a.xml', etaxXml(), org.ctxOf(who, NOW)), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await read(randomUUID(), 'a.xml', etaxXml())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await read(sharedPoId, 'a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'TYPE_NOT_ALLOWED' } } })
    expect(await read(sharedPoId, 'a.xml', new Uint8Array())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'EMPTY' } } })
  })
})
