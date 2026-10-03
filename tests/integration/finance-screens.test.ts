import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { exportAgain, exportNow } from '@/app/(workspace)/finance/exports/commands'
import { previewInvoiceFor, readEtaxFor, recordInvoiceFor } from '@/app/(workspace)/finance/invoices/commands'
import { putObject } from '@/integrations/storage'
import { prisma } from '@/server/db/client'
import { exportExpress } from '@/server/services/exports/express'
import { getExportOverview } from '@/server/services/exports/view'
import { getDownloadUrl } from '@/server/services/files'
import { recordInvoice } from '@/server/services/invoices'
import { getInvoicePoView, listInvoiceWork, previewInvoice } from '@/server/services/invoices/view'
import { closePurchaseOrder } from '@/server/services/purchase-orders'
import { postGoodsReceipt } from '@/server/services/receiving'
import { etaxOutcomeOf, FINANCE_ERROR_KEYS, financeErrorKey, type FinanceFailure } from '@/ui/finance/outcome'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { etaxXml, pdfWithEmbedded, type EtaxXmlValues } from '../support/etax-files'
import { p2p } from '../support/p2p'

// S4-08, S4-17 and S4-09, the screen side of finance (FR-P2P-008, FR-P2P-009): the POs that wait for an invoice with
// what was received, invoiced and is still held; the check before an invoice is recorded, which must decide exactly as
// the invoice_confirmation.record command does (GC-IVC-01 to GC-IVC-05) and write nothing; the commands behind the
// invoice page's buttons and e-Tax upload (src/app/(workspace)/finance/invoices/commands.ts) — the budget moved from
// committed to actual per budget line (AC2), what a last invoice gives back (AC3, GC-BUD-05) also on a resend, the
// e-Tax reading (AC4) and where an invoice's values came from, decided by the server from the stored file (BR-IVC-05);
// who may download an invoice's file; the export page's overview and commands (AC1, AC2, AC4, BR-EXP-02), two exports
// at the same moment and a list that changed after it was ticked; and every one of them refusing whoever is not
// FINANCE. Real Postgres (BCS_TEST_DB) and the local S3 server, organizations from the §7.4 fixtures. Monday 5 Oct 2026
// 10:00 Thai time.

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
function ok<T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
function done<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r as Extract<T, { ok: true }>
}

let org: DoaOrg
let flow: ReturnType<typeof p2p>
let supplierId: string
const fin = () => org.ctxOf('fin_officer', NOW)

beforeAll(async () => {
  org = await createDoaOrg()
  flow = p2p(org, NOW)
  supplierId = (await prisma.supplier.create({ data: { organizationId: org.organizationId, code: 'S1', nameTh: 'ผู้ขายวัสดุ', taxId: '0999999000012', expressVendorCode: 'V0001' } })).id
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: org.organizationId, memberId: org.member.fin_officer!, role: 'FINANCE', grantedAt: NOW },
      { organizationId: org.organizationId, memberId: org.member.receiver_con!, role: 'RECEIVER', scopeDepartmentId: org.department.CON!, grantedAt: NOW },
    ],
  })
})

type Line = { quantity: string; unitPrice: string; description?: string }

/** Approved request lines on one PO of `supplier`, marked sent (S4-06 e-mails it; tested in po-send.test.ts) */
async function sentPo(lines: Line[], options: { supplier?: string; o?: DoaOrg; f?: ReturnType<typeof p2p> } = {}) {
  const f = options.f ?? flow
  const budgetLineId = await f.fundedLine(1_000_000n)
  const pr = await f.approvedRequest(budgetLineId, lines)
  const po = await f.approvedPo(
    pr.lines.map((l) => l.id),
    options.supplier ?? supplierId,
  )
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })
  return { ...po, budgetLineId }
}

const form = (poId: string, invoiceNo: string, net: string, vat: string, isFinal = false) => ({ poId, invoiceNo, invoiceDate: '2026-10-05', net, vat, isFinal })
/** What the invoice page sends for an invoice typed by hand, without a file */
const typed = (poId: string, invoiceNo: string, net: string, vat: string, isFinal = false) => ({ ...form(poId, invoiceNo, net, vat, isFinal), sourceFileId: null })
const receive = (poId: string, poLineId: string, received: string) => postGoodsReceipt(org.ctxOf('receiver_con', NOW), { poId, lines: [{ poLineId, received }] }, key())
const waitingRow = async (poId: string, q?: string) => ok(await listInvoiceWork(fin(), q ? { q } : {})).waiting.rows.find((r) => r.id === poId)
const balance = async (budgetLineId: string) => prisma.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId }, select: { availableSatang: true, committedSatang: true, actualSatang: true } })
const bytes = (text: string) => new TextEncoder().encode(text)
/** A test-made e-Tax Invoice by Email: a PDF/A-3 carrying its XML */
const etaxPdf = (values: EtaxXmlValues) => pdfWithEmbedded([{ name: 'attachment-1', content: etaxXml(values) }])

describe('the POs that wait for an invoice, with what was received, invoiced and is still held (§9.1 /finance/invoices, BR-IVC-02)', () => {
  it('lists a sent PO, follows its invoices, and lets it go with the last one', async () => {
    const po = await sentPo([
      { quantity: '10', unitPrice: '100.00' },
      { quantity: '5', unitPrice: '200.00' },
    ])
    expect(await waitingRow(po.id)).toMatchObject({ status: 'SENT', number: po.number, netSatang: 200_000n, receivedSatang: 0n, invoicedSatang: 0n, heldSatang: 200_000n, invoiceCount: 0, supplier: { code: 'S1' } })
    ok(await receive(po.id, po.lines[0]!.id, '4'))
    done(await recordInvoiceFor(fin(), typed(po.id, 'L-1', '500.00', '35.00'), randomUUID()))
    // Found by its number, by the supplier's code and by part of the supplier's name
    for (const q of [po.number!, 's1', 'วัสดุ']) expect(await waitingRow(po.id, q), q).toMatchObject({ status: 'PARTIALLY_RECEIVED', receivedSatang: 40_000n, invoicedSatang: 50_000n, heldSatang: 150_000n, invoiceCount: 1 })
    const recorded = ok(await listInvoiceWork(fin(), { q: 'L-1' })).recorded.rows
    expect(recorded.find((r) => r.po.id === po.id)).toMatchObject({ invoiceNo: 'L-1', netSatang: 50_000n, vatSatang: 3_500n, grossSatang: 53_500n, isFinal: false, parsedFrom: 'MANUAL', exportedAt: null, file: null, recordedBy: { id: org.member.fin_officer } })

    done(await recordInvoiceFor(fin(), typed(po.id, 'L-2', '100.00', '7.00', true), randomUUID()))
    expect(await waitingRow(po.id)).toBeUndefined()
  })

  it('lists a closed PO while it holds budget for goods received and not invoiced, and not once nothing is held', async () => {
    const kept = await sentPo([{ quantity: '2', unitPrice: '500.00' }])
    ok(await receive(kept.id, kept.lines[0]!.id, '2'))
    ok(await closePurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: kept.id }, key()))
    expect(await waitingRow(kept.id)).toMatchObject({ status: 'CLOSED', heldSatang: 100_000n, receivedSatang: 100_000n })

    const settled = await sentPo([{ quantity: '1', unitPrice: '300.00' }])
    ok(await receive(settled.id, settled.lines[0]!.id, '1'))
    done(await recordInvoiceFor(fin(), typed(settled.id, 'SET-1', '300.00', '21.00'), randomUUID()))
    // Invoiced in full without being the last: nothing is held, so no invoice can follow
    expect(await waitingRow(settled.id)).toBeUndefined()
    expect(ok(await getInvoicePoView(fin(), settled.id)).blocked).toBe('NOTHING_HELD')
  })
})

describe('[FR-P2P-008/AC1] the check before recording decides as the command does (GC-IVC-04, GC-IVC-05 through the screen)', () => {
  it('shares by what each line holds, largest remainder, writes nothing, and the invoice then records exactly that', async () => {
    const po = await sentPo([
      { quantity: '1', unitPrice: '3333.33' },
      { quantity: '1', unitPrice: '6666.67' },
    ])
    const before = await balance(po.budgetLineId)
    const preview = ok(await previewInvoice(fin(), form(po.id, 'B1', '1000.00', '70.00')))
    expect(preview.parts.map((p) => [p.poLineId, p.netSatang])).toEqual([
      [po.lines[0]!.id, 33_333n],
      [po.lines[1]!.id, 66_667n],
    ])
    expect(preview).toMatchObject({ grossSatang: 107_000n, expectedVatSatang: 7_000n, vatWarning: false, heldBeforeSatang: 1_000_000n, heldAfterSatang: 900_000n, isFinal: false, giveBack: null, source: { parsedFrom: 'MANUAL', withFile: false } })
    expect(preview.byBudgetLine).toEqual([{ budgetLine: expect.objectContaining({ id: po.budgetLineId }), netSatang: 100_000n }])
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
    expect(await balance(po.budgetLineId)).toEqual(before)

    // Typed with a thousands separator, as people type money
    const recorded = done(await recordInvoiceFor(fin(), typed(po.id, 'B1', '1,000.00', '70.00'), randomUUID())).done
    expect(recorded.parts.map((p) => [p.poLineId, p.amount])).toEqual([
      [po.lines[0]!.id, '333.33'],
      [po.lines[1]!.id, '666.67'],
    ])
    expect(recorded).toMatchObject({ invoiceNo: 'B1', vatWarning: null, isFinal: false, parsedFrom: 'MANUAL', giveBack: null, heldAfter: '9,000.00', more: true })
    expect(
      (await prisma.invoiceLineAllocation.findMany({ where: { invoice: { poId: po.id } }, select: { poLineId: true, netSatang: true }, orderBy: { netSatang: 'asc' } })).map((a) => [a.poLineId, a.netSatang]),
    ).toEqual([
      [po.lines[0]!.id, 33_333n],
      [po.lines[1]!.id, 66_667n],
    ])
  })

  it('warns of a VAT more than 1.00 baht from the PO rate before recording and after, without refusing', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '1000.00' }])
    expect(ok(await previewInvoice(fin(), form(po.id, 'V-1', '100.00', '8.00')))).toMatchObject({ vatWarning: false, expectedVatSatang: 700n })
    const preview = done(await previewInvoiceFor(fin(), form(po.id, 'V-2', '100.00', '9.01'), 'th')).preview
    expect(preview).toMatchObject({ vatWarning: true, vat: '9.01', expectedVat: '7.00', vatRate: '7', gross: '109.01' })
    expect(done(await recordInvoiceFor(fin(), typed(po.id, 'V-2', '100.00', '9.01'), randomUUID())).done.vatWarning).toEqual({ expected: '7.00', given: '9.01' })
  })

  it('refuses what the command refuses, with the same codes and words, and writes nothing', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '1000.00' }])
    done(await recordInvoiceFor(fin(), typed(po.id, 'INV001', '100.00', '7.00'), randomUUID()))
    const invoices = await prisma.invoiceConfirmation.count({ where: { poId: po.id } })

    // GC-IVC-04: the same number written another way
    const duplicate = (await previewInvoiceFor(fin(), form(po.id, ' inv 001', '100.00', '7.00'), 'th')) as FinanceFailure
    expect(duplicate).toMatchObject({ ok: false, code: 'DUPLICATE_INVOICE', invoiceNo: 'INV001' })
    expect(financeErrorKey(duplicate)).toBe('DUPLICATE_INVOICE')
    // BR-IVC-02: more than the PO still holds; the screen gets what is left, formatted
    const exceeds = (await previewInvoiceFor(fin(), form(po.id, 'X-9', '900.01', '63.00'), 'th')) as FinanceFailure
    expect(exceeds).toMatchObject({ ok: false, code: 'INVOICE_EXCEEDS_COMMITTED', remaining: '900.00' })
    expect(financeErrorKey(exceeds)).toBe('EXCEEDS')
    expect(await recordInvoiceFor(fin(), typed(po.id, 'X-9', '900.01', '63.00'), randomUUID())).toMatchObject({ ok: false, code: 'INVOICE_EXCEEDS_COMMITTED', remaining: '900.00' })
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(invoices)

    // Not sent yet, and after the last invoice
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'APPROVED' } })
    expect(await previewInvoice(fin(), form(po.id, 'X-1', '1.00', '0.07'))).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(ok(await getInvoicePoView(fin(), po.id)).blocked).toBe('NOT_SENT')
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT' } })
    done(await recordInvoiceFor(fin(), typed(po.id, 'LAST', '100.00', '7.00', true), randomUUID()))
    const final = (await previewInvoiceFor(fin(), form(po.id, 'X-2', '1.00', '0.07'), 'th')) as FinanceFailure
    expect(financeErrorKey(final)).toBe('FINAL_RECORDED')
    expect(ok(await getInvoicePoView(fin(), po.id)).blocked).toBe('FINAL_RECORDED')
  })

  it('cleans and checks the typed values before the service, so a wrong field is named', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '1000.00' }])
    const cases: Array<[Record<string, unknown>, Partial<FinanceFailure>]> = [
      [form(po.id, '   ', '1.00', '0.07'), { field: 'invoiceNo' }],
      [{ ...form(po.id, 'A', '1.00', '0.07'), invoiceDate: '2026-02-30' }, { field: 'invoiceDate' }],
      [form(po.id, 'A', 'ห้าร้อย', '0.07'), { field: 'net' }],
      [form(po.id, 'A', '1.005', '0.07'), { field: 'net' }],
      [form(po.id, 'A', '0.00', '0.00'), { field: 'net', reason: 'AMOUNT_NOT_POSITIVE' }],
      [form(po.id, 'A', '1.00', '-1'), { field: 'vat' }],
      [{ ...form(po.id, 'A', '1.00', '0.07'), sourceFileId: 'not-a-file' }, { field: 'input' }],
      [{ poId: po.id }, { field: 'input' }],
    ]
    for (const [input, failure] of cases) expect(await previewInvoiceFor(fin(), input, 'th'), JSON.stringify(input)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', ...failure })
    expect(await recordInvoiceFor(fin(), typed(po.id, 'A', '1.00', '0.07'), 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
  })
})

describe('[FR-P2P-008/AC2] recording moves committed to actual on each budget line, and the answer says how much', () => {
  it('shares one invoice over PO lines of two budget lines and moves each part on its own line', async () => {
    const lineA = await flow.fundedLine(100_000n)
    const lineB = await flow.fundedLine(100_000n)
    const a = await flow.approvedRequest(lineA, [{ quantity: '1', unitPrice: '4000.00', description: 'ของฝ่าย A' }])
    const b = await flow.approvedRequest(lineB, [{ quantity: '1', unitPrice: '6000.00', description: 'ของฝ่าย B' }])
    const po = await flow.approvedPo([a.lines[0]!.id, b.lines[0]!.id], supplierId)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: NOW } })

    const preview = ok(await previewInvoice(fin(), form(po.id, 'C-77', '5000.00', '350.00')))
    expect(preview.byBudgetLine.map((m) => [m.budgetLine.id, m.netSatang])).toEqual(
      expect.arrayContaining([
        [lineA, 200_000n],
        [lineB, 300_000n],
      ]),
    )
    const recorded = done(await recordInvoiceFor(fin(), typed(po.id, 'C-77', '5,000.00', '350.00'), randomUUID())).done
    expect(recorded.moves).toEqual(
      expect.arrayContaining([
        { budgetLineId: lineA, budgetLine: expect.stringMatching(/^CON-.+ · งบทดสอบ$/), amount: '2,000.00' },
        { budgetLineId: lineB, budgetLine: expect.stringMatching(/^CON-.+ · งบทดสอบ$/), amount: '3,000.00' },
      ]),
    )
    expect(await balance(lineA)).toMatchObject({ committedSatang: 200_000n, actualSatang: 200_000n })
    expect(await balance(lineB)).toMatchObject({ committedSatang: 300_000n, actualSatang: 300_000n })
    // The PO page shows the same, line by line
    const view = ok(await getInvoicePoView(fin(), po.id))
    expect(view.lines.map((l) => [l.budgetLine.id, l.committedSatang, l.actualSatang, l.invoicedSatang])).toEqual(
      expect.arrayContaining([
        [lineA, 200_000n, 200_000n, 200_000n],
        [lineB, 300_000n, 300_000n, 300_000n],
      ]),
    )
    expect(view).toMatchObject({ invoicedSatang: 500_000n, heldSatang: 500_000n, blocked: null })
    expect(view.invoices[0]).toMatchObject({ invoiceNo: 'C-77', parts: expect.arrayContaining([{ poLineId: expect.any(String), netSatang: 200_000n }]) })
  })
})

describe('[FR-P2P-008/AC3] a last invoice: the check and the answer say what goes back (GC-BUD-05, BR-BUD-06)', () => {
  it('on an open PO: ready to close, and closing gives back what is still held', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '115000.00' }])
    ok(await receive(po.id, po.lines[0]!.id, '1'))
    const preview = ok(await previewInvoice(fin(), form(po.id, 'INV-110', '110000.00', '7700.00', true)))
    expect(preview.giveBack).toEqual({ when: 'ON_CLOSE', amountSatang: 500_000n, unsettledLines: 0 })
    const recorded = done(await recordInvoiceFor(fin(), typed(po.id, 'INV-110', '110,000.00', '7,700.00', true), randomUUID())).done
    expect(recorded).toMatchObject({ isFinal: true, more: false, giveBack: { when: 'ON_CLOSE', amount: '5,000.00', unsettledLines: 0 } })
    const before = await balance(po.budgetLineId)
    ok(await closePurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: po.id }, key()))
    const after = await balance(po.budgetLineId)
    expect(after.availableSatang - before.availableSatang).toBe(500_000n)
    expect(after).toMatchObject({ committedSatang: 0n, actualSatang: 11_000_000n })
    expect(ok(await getInvoicePoView(fin(), po.id))).toMatchObject({ status: 'CLOSED', heldSatang: 0n, blocked: 'FINAL_RECORDED' })
  })

  it('on a PO closed before its invoice: what is left goes back as the invoice is recorded', async () => {
    const po = await sentPo([{ quantity: '2', unitPrice: '500.00' }])
    ok(await receive(po.id, po.lines[0]!.id, '2'))
    ok(await closePurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: po.id }, key()))
    expect(ok(await previewInvoice(fin(), form(po.id, 'LATE-1', '900.00', '63.00', true))).giveBack).toEqual({ when: 'NOW', amountSatang: 10_000n, unsettledLines: 0 })
    const before = await balance(po.budgetLineId)
    const recorded = done(await recordInvoiceFor(fin(), typed(po.id, 'LATE-1', '900.00', '63.00', true), randomUUID())).done
    expect(recorded.giveBack).toEqual({ when: 'NOW', amount: '100.00', unsettledLines: 0 })
    const after = await balance(po.budgetLineId)
    expect(after.availableSatang - before.availableSatang).toBe(10_000n)
    expect(after).toMatchObject({ committedSatang: 0n, actualSatang: 90_000n })
  })

  it('a resend of the same submission answers the same: what went back is still said, and nothing is recorded twice', async () => {
    const po = await sentPo([{ quantity: '2', unitPrice: '500.00' }])
    ok(await receive(po.id, po.lines[0]!.id, '2'))
    ok(await closePurchaseOrder(org.ctxOf('proc_officer', NOW), { poId: po.id }, key()))
    const submission = randomUUID()
    const values = typed(po.id, 'RESEND-1', '900.00', '63.00', true)
    const first = done(await recordInvoiceFor(fin(), values, submission)).done
    // The answer was lost and the same submission is sent again: the PO gave its budget back already
    const again = done(await recordInvoiceFor(fin(), values, submission)).done
    expect(first.giveBack).toEqual({ when: 'NOW', amount: '100.00', unsettledLines: 0 })
    expect(again).toEqual(first)
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(1)
    expect(await balance(po.budgetLineId)).toMatchObject({ committedSatang: 0n, actualSatang: 90_000n })
  })

  it('on a PO with goods still to come: says closing waits for them', async () => {
    const po = await sentPo([{ quantity: '10', unitPrice: '100.00' }])
    ok(await receive(po.id, po.lines[0]!.id, '6'))
    expect(ok(await previewInvoice(fin(), form(po.id, 'P-1', '600.00', '42.00', true))).giveBack).toEqual({ when: 'ON_CLOSE', amountSatang: 40_000n, unsettledLines: 1 })
  })
})

describe('[FR-P2P-008/AC4] an e-Tax file read through the screen fills the form, or says why it cannot (BR-IVC-05)', () => {
  it('a PDF/A-3 with its XML fills the form; confirmed, the invoice keeps the file as ETAX', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const pdf = pdfWithEmbedded([
      { name: 'logo.txt', content: 'not xml' },
      { name: 'attachment-1', content: etaxXml({ invoiceNo: 'ET-SCR-1', sellerRegistration: '099999900001200000' }) },
    ])
    const reading = done(await readEtaxFor(fin(), po.id, 'ใบกำกับ ET-SCR-1.pdf', pdf))
    expect(reading).toEqual({
      ok: true,
      fileId: expect.any(String),
      fileName: 'ใบกำกับ ET-SCR-1.pdf',
      problems: [],
      prefill: { invoiceNo: 'ET-SCR-1', invoiceDate: '2026-10-05', net: '10000.00', vat: '700.00', gross: '10700.00', sellerTaxId: '0-9999-99000-01-2', sellerBranch: '00000' },
    })
    const p = reading.prefill!
    const values = { ...form(po.id, p.invoiceNo, p.net, p.vat), invoiceDate: p.invoiceDate, sourceFileId: reading.fileId }
    // The check before recording says it will count as read from the file: the server decides, from the file
    expect(done(await previewInvoiceFor(fin(), values, 'th')).preview).toMatchObject({ source: 'ETAX_XML', withFile: true })
    expect(done(await recordInvoiceFor(fin(), values, randomUUID())).done.parsedFrom).toBe('ETAX_XML')
    const invoice = await prisma.invoiceConfirmation.findFirstOrThrow({ where: { poId: po.id } })
    expect(invoice).toMatchObject({ parsedFrom: 'ETAX_XML', sourceFileId: reading.fileId, netSatang: 1_000_000n, vatSatang: 70_000n })
    expect(await prisma.fileLink.findMany({ where: { subjectId: invoice.id }, select: { kind: true } })).toEqual([{ kind: 'ETAX' }])
    expect(ok(await listInvoiceWork(fin(), { q: 'ET-SCR-1' })).recorded.rows[0]).toMatchObject({ parsedFrom: 'ETAX_XML', file: { id: reading.fileId, fileName: 'ใบกำกับ ET-SCR-1.pdf' } })
  })

  it('a seller that is not the PO supplier, or a broken file: the reason and no values', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    expect(await readEtaxFor(fin(), po.id, 'other.xml', bytes(etaxXml({ sellerRegistration: '010555512345600000' })))).toMatchObject({ ok: true, prefill: null, problems: ['TAX_ID_MISMATCH'] })
    expect(await readEtaxFor(fin(), po.id, 'broken.xml', bytes(etaxXml().replace('</ram:ID>', '')))).toMatchObject({ ok: true, prefill: null, problems: ['XML_UNREADABLE'] })
    expect(await readEtaxFor(fin(), po.id, 'scan.pdf', pdfWithEmbedded([]))).toMatchObject({ ok: true, prefill: null, problems: ['NOT_AN_ETAX_INVOICE'] })
    const picture = (await readEtaxFor(fin(), po.id, 'a.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))) as FinanceFailure
    expect(picture).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'TYPE_NOT_ALLOWED' })
    expect(financeErrorKey(picture)).toBe('FILE_TYPE')
    expect(await readEtaxFor(fin(), 'not-a-po', 'a.xml', bytes(etaxXml()))).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('values typed over an e-Tax file are recorded as typed, whatever the browser says, and the file stays as the invoice’s paper', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const reading = done(await readEtaxFor(fin(), po.id, 'et-1.pdf', etaxPdf({ invoiceNo: 'ET-1', net: '500.00', vat: '35.00', gross: '535.00' })))
    expect(reading.prefill).toMatchObject({ invoiceNo: 'ET-1', net: '500.00', vat: '35.00' })
    const values = { ...form(po.id, 'TYPED-999', '900.00', '63.00'), sourceFileId: reading.fileId }
    expect(done(await previewInvoiceFor(fin(), values, 'th')).preview).toMatchObject({ source: 'MANUAL', withFile: true })
    // A browser that says the values came from the file is not believed: the page's input has no such field
    const recorded = done(await recordInvoiceFor(fin(), { ...values, parsedFrom: 'ETAX_XML' }, randomUUID())).done
    expect(recorded.parsedFrom).toBe('MANUAL')
    const invoice = await prisma.invoiceConfirmation.findFirstOrThrow({ where: { poId: po.id } })
    expect(invoice).toMatchObject({ invoiceNo: 'TYPED-999', parsedFrom: 'MANUAL', sourceFileId: reading.fileId, netSatang: 90_000n })
    expect(await prisma.fileLink.findMany({ where: { subjectId: invoice.id }, select: { kind: true } })).toEqual([{ kind: 'INVOICE' }])
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'invoice_confirmation.recorded', aggregateId: invoice.id } })).toMatchObject({ data: { parsedFrom: 'MANUAL' } })
  })

  it('a caller that claims ETAX_XML for values the file does not bear is refused, and nothing is recorded', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const reading = done(await readEtaxFor(fin(), po.id, 'et-2.pdf', etaxPdf({ invoiceNo: 'ET-2', net: '500.00', vat: '35.00', gross: '535.00' })))
    const claim = { poId: po.id, invoiceDate: '2026-10-05', parsedFrom: 'ETAX_XML' as const }
    expect(await recordInvoice(fin(), { ...claim, invoiceNo: 'TYPED-998', net: '900.00', vat: '63.00', sourceFileId: reading.fileId }, key())).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_FAILED', details: { field: 'parsedFrom', reason: 'NOT_AS_READ' } },
    })
    expect(await recordInvoice(fin(), { ...claim, invoiceNo: 'ET-2', net: '500.00', vat: '35.00' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_AS_READ' } } })
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
    // The values as read, with the file: ETAX_XML
    expect(ok(await recordInvoice(fin(), { ...claim, invoiceNo: 'ET-2', net: '500.00', vat: '35.00', sourceFileId: reading.fileId }, key()))).toMatchObject({ parsedFrom: 'ETAX_XML' })
  })

  it('a file whose seller is not the PO supplier is never attached: refused at the check and at recording', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const reading = done(await readEtaxFor(fin(), po.id, 'other.pdf', etaxPdf({ invoiceNo: 'OTHER-1', sellerRegistration: '010555512345600000' })))
    expect(reading).toMatchObject({ prefill: null, problems: ['TAX_ID_MISMATCH'] })
    const values = { ...form(po.id, 'OTHER-1', '10000.00', '700.00'), sourceFileId: reading.fileId }
    const checked = (await previewInvoiceFor(fin(), values, 'th')) as FinanceFailure
    expect(checked).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'sourceFileId', reason: 'TAX_ID_MISMATCH' })
    expect(financeErrorKey(checked)).toBe('FILE_SELLER')
    expect(await recordInvoiceFor(fin(), values, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'TAX_ID_MISMATCH' })
    expect(await recordInvoice(fin(), { ...values, parsedFrom: 'ETAX_XML' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TAX_ID_MISMATCH' } } })
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
    expect(await prisma.fileLink.count({ where: { fileId: reading.fileId } })).toBe(0)
  })
})

describe('an invoice’s file is one its recorder uploaded for this PO, unchanged, and the paper of one invoice only (BR-IVC-05)', () => {
  it('refuses a file read for another PO, a file already with an invoice, another member’s file and a file changed in storage', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const other = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const xml = (invoiceNo: string) => bytes(etaxXml({ invoiceNo }))

    const readForOther = done(await readEtaxFor(fin(), other.id, 'moved.xml', xml('MOVE-1')))
    const moved = (await recordInvoiceFor(fin(), { ...form(po.id, 'MOVE-1', '10000.00', '700.00'), sourceFileId: readForOther.fileId }, randomUUID())) as FinanceFailure
    expect(moved).toMatchObject({ ok: false, reason: 'FILE_OTHER_PO' })
    expect(financeErrorKey(moved)).toBe('FILE_OTHER_PO')

    const reading = done(await readEtaxFor(fin(), po.id, 'used.xml', xml('USE-1')))
    expect(done(await recordInvoiceFor(fin(), { ...form(po.id, 'USE-1', '10000.00', '700.00'), sourceFileId: reading.fileId }, randomUUID())).done.parsedFrom).toBe('ETAX_XML')
    const reused = (await previewInvoiceFor(fin(), { ...form(po.id, 'USE-2', '100.00', '7.00'), sourceFileId: reading.fileId }, 'th')) as FinanceFailure
    expect(reused).toMatchObject({ ok: false, reason: 'FILE_IN_USE' })
    expect(financeErrorKey(reused)).toBe('FILE_IN_USE')
    expect(await recordInvoiceFor(fin(), { ...form(po.id, 'USE-2', '100.00', '7.00'), sourceFileId: reading.fileId }, randomUUID())).toMatchObject({ ok: false, reason: 'FILE_IN_USE' })

    // Bound to this PO, but uploaded by someone else; and one whose stored bytes are not the ones uploaded
    const storageKey = () => `org/${org.organizationId}/invoice-files/${po.id}/${randomUUID()}`
    const othersKey = storageKey()
    await putObject(othersKey, xml('THEIRS-1'), 'application/xml')
    const others = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: othersKey, fileName: 'theirs.xml', mimeType: 'application/xml', sizeBytes: 1, sha256: '0'.repeat(64), status: 'AVAILABLE', uploadedById: org.member.req_con! } })
    expect(await recordInvoiceFor(fin(), { ...form(po.id, 'THEIRS-1', '100.00', '7.00'), sourceFileId: others.id }, randomUUID())).toMatchObject({ ok: false, reason: 'FILE' })
    const changedKey = storageKey()
    await putObject(changedKey, xml('CHANGED-1'), 'application/xml')
    const changed = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: changedKey, fileName: 'changed.xml', mimeType: 'application/xml', sizeBytes: 1, sha256: '0'.repeat(64), status: 'AVAILABLE', uploadedById: org.member.fin_officer! } })
    expect(await recordInvoiceFor(fin(), { ...form(po.id, 'CHANGED-1', '100.00', '7.00'), sourceFileId: changed.id }, randomUUID())).toMatchObject({ ok: false, reason: 'FILE' })

    expect(await prisma.invoiceConfirmation.findMany({ where: { poId: { in: [po.id, other.id] } }, select: { invoiceNo: true } })).toEqual([{ invoiceNo: 'USE-1' }])
  })
})

describe('[FR-PLT-004/AC2] an invoice’s file downloads only after the check of the invoice: FINANCE and the AUDITOR', () => {
  it('gives FINANCE and the AUDITOR a short-lived address, and refuses procurement, requesters and approvers', async () => {
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.auditor!, role: 'AUDITOR', grantedAt: NOW } })
    const po = await sentPo([{ quantity: '1', unitPrice: '20000.00' }])
    const reading = done(await readEtaxFor(fin(), po.id, 'paper.xml', bytes(etaxXml({ invoiceNo: 'DL-1' }))))
    // Not with an invoice yet: only who uploaded it
    expect(await getDownloadUrl(fin(), { fileId: reading.fileId })).toMatchObject({ ok: true })
    expect(await getDownloadUrl(org.ctxOf('auditor', NOW), { fileId: reading.fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })

    done(await recordInvoiceFor(fin(), { ...form(po.id, 'DL-1', '10000.00', '700.00'), sourceFileId: reading.fileId }, randomUUID()))
    for (const who of ['fin_officer', 'auditor']) {
      const url = ok(await getDownloadUrl(org.ctxOf(who, NOW), { fileId: reading.fileId }))
      expect(url.url, who).toMatch(/^https?:\/\//)
      expect(url.expiresInSeconds, who).toBeLessThanOrEqual(300)
    }
    for (const who of ['req_con', 'proc_officer', 'coo']) expect(await getDownloadUrl(org.ctxOf(who, NOW), { fileId: reading.fileId }), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('only FINANCE sees the invoice screens and records or reads files through them (§2.4 invoiceConfirmation.record)', () => {
  it('refuses every other member, whatever the screen asks', async () => {
    const po = await sentPo([{ quantity: '1', unitPrice: '1000.00' }])
    for (const who of ['proc_officer', 'req_con', 'auditor', 'coo']) {
      const ctx = org.ctxOf(who, NOW)
      expect(await listInvoiceWork(ctx), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await getInvoicePoView(ctx, po.id), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await previewInvoice(ctx, form(po.id, 'N-1', '1.00', '0.07')), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await previewInvoiceFor(ctx, form(po.id, 'N-1', '1.00', '0.07'), 'th'), who).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await recordInvoiceFor(ctx, typed(po.id, 'N-1', '1.00', '0.07'), randomUUID()), who).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      expect(await readEtaxFor(ctx, po.id, 'a.xml', bytes(etaxXml())), who).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(await prisma.invoiceConfirmation.count({ where: { poId: po.id } })).toBe(0)
  })
})

describe('the export screen (S4-09)', () => {
  let o: DoaOrg
  let f: ReturnType<typeof p2p>
  const finOf = () => o.ctxOf('fin_officer', NOW)

  beforeAll(async () => {
    o = await createDoaOrg()
    f = p2p(o, NOW)
    await prisma.roleAssignment.create({ data: { organizationId: o.organizationId, memberId: o.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
  })

  describe('[FR-P2P-009/AC1] [FR-P2P-009/AC2] [FR-P2P-009/AC4] what the next file takes, what it keeps out, and the files made', () => {
    it('lists the invoices ready and the ones kept out by supplier, makes the file with rows, total and checksum, and makes it again only with a reason', async () => {
      const withCode = (await prisma.supplier.create({ data: { organizationId: o.organizationId, code: 'SA', nameTh: 'ผู้ขายมีรหัส', taxId: '0999999000012', expressVendorCode: 'V0101' } })).id
      const noCode = (await prisma.supplier.create({ data: { organizationId: o.organizationId, code: 'SB', nameTh: 'ผู้ขายยังไม่มีรหัส', taxId: '0999999000021' } })).id
      const a = await sentPo([{ quantity: '1', unitPrice: '1000.00' }], { supplier: withCode, o, f })
      const b = await sentPo([{ quantity: '1', unitPrice: '2000.00' }], { supplier: noCode, o, f })
      ok(await recordInvoice(finOf(), { poId: a.id, invoiceNo: 'A-1', invoiceDate: '2026-10-01', net: '1000.00', vat: '70.00' }, key()))
      ok(await recordInvoice(finOf(), { poId: b.id, invoiceNo: 'B-1', invoiceDate: '2026-10-02', net: '2000.00', vat: '140.00' }, key()))

      const overview = ok(await getExportOverview(finOf()))
      expect(overview.layout).toMatchObject({ fileType: 'xlsx', encoding: 'UTF-8-BOM', dateFormat: 'BE', needsVendorCode: true })
      expect(overview.layout!.columns[0]).toEqual({ header: 'รหัสเจ้าหนี้', field: 'expressVendorCode' })
      expect(overview.ready).toMatchObject({ count: 1, totalSatang: 107_000n })
      expect(overview.ready.shown.map((i) => [i.invoiceNo, i.supplier.expressVendorCode])).toEqual([['A-1', 'V0101']])
      expect(overview.readyFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(overview.heldBack).toMatchObject({ count: 1, totalSatang: 214_000n })
      expect(overview.heldBack.suppliers).toEqual([{ supplier: { id: noCode, code: 'SB', name: { th: 'ผู้ขายยังไม่มีรหัส', en: null } }, count: 1, totalSatang: 214_000n, invoices: [{ id: expect.any(String), invoiceNo: 'B-1', poNumber: b.number, grossSatang: 214_000n }] }])
      expect(overview.jobs).toEqual([])

      // The tick is the confirmation (marking invoices exported cannot be undone), with the list it confirms
      const ticked = (fingerprint: string) => ({ confirmed: true, fingerprint })
      expect(await exportNow(finOf(), { confirmed: false, fingerprint: overview.readyFingerprint }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'confirm' })
      expect(await exportNow(finOf(), { confirmed: true }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'confirm' })
      expect(await exportNow(finOf(), ticked(overview.readyFingerprint), 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
      const made = done(await exportNow(finOf(), ticked(overview.readyFingerprint), randomUUID()))
      expect(made).toMatchObject({ rowCount: 1, total: '1,070.00', excluded: 1, checksum: expect.stringMatching(/^[0-9a-f]{64}$/) })

      const after = ok(await getExportOverview(finOf()))
      expect(after.ready.count).toBe(0)
      expect(after.heldBack.count).toBe(1)
      expect(after.jobs).toHaveLength(1)
      expect(after.jobs[0]).toMatchObject({ id: made.exportJobId, rowCount: 1, totalSatang: 107_000n, checksum: made.checksum, reason: null, file: { id: made.fileId }, requestedBy: { id: o.member.fin_officer } })
      expect(after.jobs[0]!.invoiceIds).toHaveLength(1)
      // Nothing left that the file can take: the kept-out invoice is named
      const nothing = (await exportNow(finOf(), ticked(after.readyFingerprint), randomUUID())) as FinanceFailure
      expect(nothing).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'NOTHING_TO_EXPORT', excluded: 1 })
      expect(financeErrorKey(nothing)).toBe('NOTHING_TO_EXPORT_HELD')

      // BR-EXP-02: the same invoices again only with a reason, as a new file
      expect(await exportAgain(finOf(), { exportJobId: made.exportJobId, reason: ' x ' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'reason', reason: 'REASON_REQUIRED' })
      const again = done(await exportAgain(finOf(), { exportJobId: made.exportJobId, reason: 'ไฟล์เดิมนำเข้าไม่สำเร็จ' }, randomUUID()))
      expect(again.exportJobId).not.toBe(made.exportJobId)
      expect(again).toMatchObject({ rowCount: 1, total: '1,070.00' })
      expect(ok(await getExportOverview(finOf())).jobs[0]).toMatchObject({ id: again.exportJobId, reason: 'ไฟล์เดิมนำเข้าไม่สำเร็จ' })
      expect(await exportAgain(finOf(), { exportJobId: randomUUID(), reason: 'ไฟล์หาย' }, randomUUID())).toMatchObject({ ok: false, code: 'NOT_FOUND' })

      // AC4: once procurement fills the vendor code, the kept-out invoice goes into the next file
      await prisma.supplier.update({ where: { id: noCode }, data: { expressVendorCode: 'V0202' } })
      const filled = ok(await getExportOverview(finOf()))
      expect(filled).toMatchObject({ ready: { count: 1, totalSatang: 214_000n }, heldBack: { count: 0, suppliers: [] } })
      expect(done(await exportNow(finOf(), ticked(filled.readyFingerprint), randomUUID()))).toMatchObject({ rowCount: 1, total: '2,140.00', excluded: 0 })
    })
  })

  describe('the file’s name', () => {
    it('is the organization’s own date, not the UTC one (a file made at 01:30 in Bangkok)', async () => {
      const supplier = (await prisma.supplier.create({ data: { organizationId: o.organizationId, code: 'SC', nameTh: 'ผู้ขายรอบดึก', taxId: '0999999000039', expressVendorCode: 'V0303' } })).id
      const po = await sentPo([{ quantity: '1', unitPrice: '500.00' }], { supplier, o, f })
      ok(await recordInvoice(finOf(), { poId: po.id, invoiceNo: 'TZ-1', invoiceDate: '2026-10-05', net: '500.00', vat: '35.00' }, key()))
      const lateNight = o.ctxOf('fin_officer', new Date('2026-10-04T18:30:00Z'))
      const made = done(await exportNow(lateNight, { confirmed: true, fingerprint: ok(await getExportOverview(lateNight)).readyFingerprint }, randomUUID()))
      expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: made.fileId }, select: { fileName: true } })).fileName).toMatch(/^express-2026-10-05-[0-9a-f]{6}\.xlsx$/)
    })
  })

  describe('who may use it (§2.4 export.express)', () => {
    it('refuses every other member, whatever the screen asks', async () => {
      const job = await prisma.exportJob.findFirst({ where: { organizationId: o.organizationId }, select: { id: true } })
      for (const who of ['proc_officer', 'req_con', 'auditor', 'coo']) {
        const ctx = o.ctxOf(who, NOW)
        expect(await getExportOverview(ctx), who).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
        expect(await exportNow(ctx, { confirmed: true, fingerprint: '0'.repeat(64) }, randomUUID()), who).toMatchObject({ ok: false, code: 'FORBIDDEN' })
        expect(await exportAgain(ctx, { exportJobId: job?.id ?? randomUUID(), reason: 'ลองส่งออกซ้ำ' }, randomUUID()), who).toMatchObject({ ok: false, code: 'FORBIDDEN' })
      }
    })
  })
})

describe('[FR-P2P-009/AC1] a first export takes the invoices not exported yet — each into one file, and only the list that was ticked (BR-EXP-02)', () => {
  let r: DoaOrg
  let supplier: string
  let budgetLineId: string
  let seq = 0
  const finR = () => r.ctxOf('fin_officer', NOW)

  beforeAll(async () => {
    r = await createDoaOrg()
    await prisma.roleAssignment.create({ data: { organizationId: r.organizationId, memberId: r.member.fin_officer!, role: 'FINANCE', grantedAt: NOW } })
    supplier = (await prisma.supplier.create({ data: { organizationId: r.organizationId, code: 'SR', nameTh: 'ผู้ขายรอบพร้อมกัน', taxId: '0999999000012', expressVendorCode: 'V0909' } })).id
    budgetLineId = (await prisma.budgetLine.findFirstOrThrow({ where: { organizationId: r.organizationId, code: 'CON-OPEX-2569' } })).id
  })

  /** An invoice waiting for export, written directly: the export only reads invoices (recording is tested above) */
  async function waitingInvoice(invoiceNo: string): Promise<string> {
    seq++
    const net = 100_000n
    const po = await prisma.purchaseOrder.create({ data: { organizationId: r.organizationId, number: `PO-2569-${String(8000 + seq).padStart(5, '0')}`, status: 'SENT', supplierId: supplier, netSatang: net, vatSatang: 7_000n, grossSatang: 107_000n, vatRateBp: 700 } })
    const line = await prisma.poLine.create({ data: { organizationId: r.organizationId, poId: po.id, lineNo: 1, description: 'ของ', quantity: '1', uom: 'ชิ้น', unitPriceSatang: net, netSatang: net, budgetLineId } })
    const invoice = await prisma.invoiceConfirmation.create({
      data: { organizationId: r.organizationId, poId: po.id, supplierId: supplier, invoiceNo, invoiceNoNormalized: invoiceNo, invoiceDate: new Date('2026-10-01T00:00:00Z'), netSatang: net, vatSatang: 7_000n, grossSatang: 107_000n, recordedById: r.member.fin_officer!, recordedAt: NOW },
    })
    await prisma.invoiceLineAllocation.create({ data: { organizationId: r.organizationId, invoiceId: invoice.id, poLineId: line.id, netSatang: net } })
    return invoice.id
  }

  it('two officers making the file at the same moment: one file takes every invoice, the others are refused', async () => {
    const ids = [await waitingInvoice('R-1'), await waitingInvoice('R-2'), await waitingInvoice('R-3')]
    const results = await Promise.all([1, 2, 3, 4].map(() => exportExpress(finR(), {}, key())))
    const made = results.flatMap((x) => (x.ok ? [x.data] : []))
    expect(made).toHaveLength(1)
    // Refused: the other file took the invoices first (or, started after it, nothing was left)
    for (const refused of results.filter((x) => !x.ok)) expect(refused).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(CONFLICT_VERSION|VALIDATION_FAILED|RATE_LIMITED)$/) } })
    expect(made[0]).toMatchObject({ rowCount: 3, total: '3210.00' })
    const jobs = await prisma.exportJob.findMany({ where: { organizationId: r.organizationId, kind: 'EXPRESS_AP' }, select: { id: true, reason: true } })
    expect(jobs).toEqual([{ id: made[0]!.exportJobId, reason: null }])
    expect((await prisma.invoiceConfirmation.findMany({ where: { id: { in: ids } }, select: { exportJobId: true } })).map((i) => i.exportJobId)).toEqual([made[0]!.exportJobId, made[0]!.exportJobId, made[0]!.exportJobId])
    expect(await prisma.event.count({ where: { organizationId: r.organizationId, type: 'export.generated' } })).toBe(1)
  })

  it('the list ticked is the list exported: an invoice recorded meanwhile refuses the file until the page shows it', async () => {
    const first = await waitingInvoice('S-1')
    const seen = ok(await getExportOverview(finR()))
    expect(seen.ready.count).toBe(1)
    const late = await waitingInvoice('S-2')
    const refused = (await exportNow(finR(), { confirmed: true, fingerprint: seen.readyFingerprint }, randomUUID())) as FinanceFailure
    expect(refused).toMatchObject({ ok: false, code: 'CONFLICT_VERSION', reason: 'PENDING_CHANGED' })
    expect(financeErrorKey(refused)).toBe('PENDING_CHANGED')
    expect(await prisma.invoiceConfirmation.count({ where: { id: { in: [first, late] }, exportedAt: { not: null } } })).toBe(0)

    // The page shows the list again; that list is the one exported
    const now = ok(await getExportOverview(finR()))
    expect(now.ready.count).toBe(2)
    expect(now.readyFingerprint).not.toBe(seen.readyFingerprint)
    expect(done(await exportNow(finR(), { confirmed: true, fingerprint: now.readyFingerprint }, randomUUID()))).toMatchObject({ rowCount: 2, total: '2,140.00' })
    expect(await prisma.invoiceConfirmation.count({ where: { id: { in: [first, late] }, exportedAt: null } })).toBe(0)
  })
})

describe('every refusal the finance screens map has words in both languages, and an answer the page cannot read is said plainly', () => {
  it('has a message for each error key and e-Tax problem, in Thai and English', () => {
    for (const locale of ['th', 'en']) {
      const messages = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', '..', 'messages', `${locale}.json`), 'utf8')) as { finance: { errors: Record<string, string>; etaxProblems: Record<string, string> } }
      for (const k of FINANCE_ERROR_KEYS) expect(messages.finance.errors[k], `${locale} ${k}`).toEqual(expect.any(String))
      for (const k of ['XML_UNREADABLE', 'NOT_AN_ETAX_INVOICE', 'VALUE_MISSING', 'TAX_ID_MISMATCH']) expect(messages.finance.etaxProblems[k], `${locale} ${k}`).toEqual(expect.any(String))
    }
  })

  it('says a file the host refused is too large, an answer not from the app is the server’s, and an unknown refusal is not "check the internet"', () => {
    expect(financeErrorKey(etaxOutcomeOf(413, undefined) as FinanceFailure)).toBe('FILE_TOO_LARGE')
    expect(financeErrorKey(etaxOutcomeOf(502, undefined) as FinanceFailure)).toBe('SERVER')
    expect(financeErrorKey(etaxOutcomeOf(500, { message: 'oops' }) as FinanceFailure)).toBe('SERVER')
    expect(financeErrorKey(etaxOutcomeOf(403, { ok: false, code: 'FORBIDDEN' }) as FinanceFailure)).toBe('FORBIDDEN')
    expect(etaxOutcomeOf(200, { ok: true, fileId: 'f', fileName: 'a.xml', prefill: null, problems: [] })).toMatchObject({ ok: true })
    expect(financeErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'invoiceIds' })).toBe('INVALID')
    expect(financeErrorKey({ ok: false, code: 'FAILED' })).toBe('FAILED')
  })
})
