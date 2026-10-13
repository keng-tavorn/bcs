import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { confirmInvoiceCoding } from '@/server/services/ap'
import { suggestInvoiceCoding, updateAccountCode } from '@/server/services/ap/coding'
import { exportExpress } from '@/server/services/exports/express'
import { getDownloadUrl } from '@/server/services/files'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'
import { TEST_EXPRESS_LAYOUT, testExpressColumn } from '../support/express-layout'
import { setExpressLayout } from '../support/set-express-layout'

// S8-11 (FR-AP-108, BR-AP-10, OQ-128, BR-EXP-02 to BR-EXP-04): the account code each invoice line is offered from the
// history of the same supplier and category (no AI), confirmed by a person; FINANCE's list of codes; and the Express
// file that takes tier-2 invoices with their confirmed codes next to tier-1 confirmations, its total the sum of its rows.

let ap: ApOrg
let count = 0
const nextDate = () => new Date(Date.UTC(2026, 9, 10 - 4 * ++count)).toISOString().slice(0, 10)

beforeAll(async () => {
  ap = await apOrg({ modules: ['PAY'] })
  ok(await updateAccountCode(fin(ap), { code: '530601', nameTh: 'อุปกรณ์ความปลอดภัย', type: 'EXPENSE', active: true }, key()))
})

/** A ready invoice of category `category` coded `code` on one line (the history of BR-AP-10) */
async function readyInvoice(category: string, code: string | null) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: category } })
  await receive(ap, po, { 0: '1' })
  const draft = await codedDraft(ap, po, { no: `H-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '70.00', lines: [{ line: 0, quantity: '1', unitPrice: '1000.00' }] })
  if (code) {
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
    const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
    ok(await confirmInvoiceCoding(fin(ap), { invoiceId: draft.invoiceId, version, lines: [{ invoiceLineId: line.id, accountCode: code, costCenterId: line.costCenterId! }] }, key()))
  }
  const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
  expect(ok(await submit(ap, { invoiceId: draft.invoiceId, version })).status).toBe('READY_FOR_PAYMENT')
  return { po, invoiceId: draft.invoiceId }
}

describe('[FR-AP-108/AC1] [FR-AP-108/AC3] the code offered from the history, without AI', () => {
  it('the code the supplier was coded with most for the category, with how often; chosen, the line says HISTORY', async () => {
    await readyInvoice('SAFETY', '530601')
    await readyInvoice('SAFETY', '530601')
    await readyInvoice('OTHER', '530101')
    // the AI module is off in this organization (EG-1)
    expect(await prisma.orgModule.count({ where: { organizationId: ap.org.organizationId, module: 'AI', enabled: true } })).toBe(0)
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '500.00' }])
    await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: 'SAFETY' } })
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `N-${randomUUID().slice(0, 6)}`, date: '2026-10-11', vat: '35.00', lines: [{ line: 0, quantity: '1', unitPrice: '500.00' }] })
    const [s] = ok(await suggestInvoiceCoding(fin(ap), draft.invoiceId))
    expect(s).toMatchObject({ accountCode: '530601', source: 'HISTORY', count: 2 })
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
    const version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
    ok(await confirmInvoiceCoding(fin(ap), { invoiceId: draft.invoiceId, version, lines: [{ invoiceLineId: line.id, accountCode: '530601', costCenterId: s!.costCenterId }] }, key()))
    expect(await prisma.invoiceLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ accountCode: '530601', codingSource: 'HISTORY' })
  })

  it('no history: the budget line’s code; only FINANCE reads the suggestions', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '200.00' }])
    await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: 'NEW-CATEGORY' } })
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `B-${randomUUID().slice(0, 6)}`, date: '2026-10-11', vat: '14.00', lines: [{ line: 0, quantity: '1', unitPrice: '200.00' }] })
    expect(ok(await suggestInvoiceCoding(fin(ap), draft.invoiceId))[0]).toMatchObject({ accountCode: '510101', source: 'BUDGET_LINE', count: 0 })
    expect(await suggestInvoiceCoding(ap.org.ctxOf('proc_officer', AP_NOW), draft.invoiceId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AP-108/AC2] FINANCE keeps the account codes', () => {
  it('a code made inactive is refused at confirmation; PROCUREMENT may not change codes; PAY off is MODULE_DISABLED', async () => {
    ok(await updateAccountCode(fin(ap), { code: '530999', nameTh: 'ชั่วคราว', type: 'EXPENSE', active: false }, key()))
    expect(await prisma.accountCode.findFirstOrThrow({ where: { organizationId: ap.org.organizationId, code: '530999' } })).toMatchObject({ active: false })
    expect(await updateAccountCode(ap.org.ctxOf('proc_officer', AP_NOW), { code: '1', nameTh: 'x', type: 'COST', active: true }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const off = await apOrg({ modules: [] })
    expect(await updateAccountCode(fin(off), { code: '1', nameTh: 'x', type: 'COST', active: true }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[FR-AP-108/AC4] [BR-EXP-03] one Express file of tier-1 confirmations and tier-2 invoices', () => {
  it('takes both with the confirmed code of tier 2; its total is the sum of its rows and its invoices are marked exported', async () => {
    const org = await apOrg({ modules: ['PAY'] })
    await setExpressLayout(org.org.organizationId, TEST_EXPRESS_LAYOUT)
    await prisma.supplier.update({ where: { id: org.supplierId }, data: { expressVendorCode: 'V-001' } })
    // a tier-1 confirmation recorded before PAY took the organization's invoices (set up directly, as the S4 tests do)
    const old = await sentPo(org, [{ quantity: '1', unitPrice: '300.00' }])
    await prisma.purchaseOrder.update({ where: { id: old.id }, data: { invoiceTrack: 'CONFIRMATION' } })
    const confirmation = await prisma.invoiceConfirmation.create({
      data: { organizationId: org.org.organizationId, poId: old.id, supplierId: org.supplierId, invoiceNo: 'T1-001', invoiceNoNormalized: 'T1-001', invoiceDate: new Date('2026-10-01T00:00:00Z'), netSatang: 30_000n, vatSatang: 2_100n, grossSatang: 32_100n, recordedById: org.org.member.fin_officer!, recordedAt: new Date('2026-10-01T03:00:00Z') },
    })
    await prisma.invoiceLineAllocation.create({ data: { organizationId: org.org.organizationId, invoiceId: confirmation.id, poLineId: old.lines[0]!.id, netSatang: 30_000n } })
    // a tier-2 invoice ready for payment, coded 530101 by FINANCE
    const po = await sentPo(org, [{ quantity: '2', unitPrice: '1000.00' }])
    await receive(org, po, { 0: '2' })
    const draft = await codedDraft(org, po, { no: 'T2-001', date: '2026-10-05', vat: '140.00', lines: [{ line: 0, quantity: '2', unitPrice: '1000.00' }] })
    const line = await prisma.invoiceLine.findFirstOrThrow({ where: { invoiceId: draft.invoiceId } })
    let version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
    ok(await confirmInvoiceCoding(fin(org), { invoiceId: draft.invoiceId, version, lines: [{ invoiceLineId: line.id, accountCode: '530101', costCenterId: line.costCenterId! }] }, key()))
    version = (await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).version
    ok(await submit(org, { invoiceId: draft.invoiceId, version }))

    const file = ok(await exportExpress(fin(org), {}, key()))
    expect(file).toMatchObject({ rowCount: 2, total: '2461.00' })
    const url = ok(await getDownloadUrl(fin(org), { fileId: file.fileId })).url
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Buffer.from(await (await fetch(url)).arrayBuffer()) as never)
    const rows = book.worksheets[0]!.getSheetValues().slice(2) as unknown[][]
    const cell = (row: unknown[], field: Parameters<typeof testExpressColumn>[0]) => String(row[testExpressColumn(field) + 1])
    expect(rows.map((r) => cell(r, 'invoiceNo'))).toEqual(['T1-001', 'T2-001'])
    expect(cell(rows[1]!, 'accountCode')).toBe('530101')
    const sum = rows.reduce((s, r) => s + BigInt(cell(r, 'gross').replace('.', '')), 0n)
    expect(sum).toBe(246_100n)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })).exportJobId).toBe(file.exportJobId)
    expect((await prisma.invoiceConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } })).exportJobId).toBe(file.exportJobId)
  })
})
