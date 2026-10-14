import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  cancelApInvoiceFor,
  confirmApCodingFor,
  dismissApExceptionFor,
  recheckApInvoiceFor,
  rejectApInvoiceFor,
  requestApVarianceFor,
  submitApInvoiceFor,
  updateApInvoiceFor,
} from '@/app/(workspace)/finance/invoices/[poId]/ap-commands'
import { prisma } from '@/server/db/client'
import { listMyTasks } from '@/server/queries/tasks'
import { createDraftFromReading, createInvoice } from '@/server/services/ap'
import { recheckInvoice } from '@/server/services/ap/exceptions'
import { getApInvoicePage, listVarianceExceptions } from '@/server/services/ap/view-invoice'
import { getDownloadUrl } from '@/server/services/files'
import { apErrorKey } from '@/ui/ap/invoice/outcome'
import { AP_NOW, apOrg, codedDraft, fin, invoiceReading, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-13, the screens of one tier-2 invoice and PROCUREMENT's list of differences (docs/sub-specs/S8.md "หน้าจอ"
// /finance/invoices/[id] and /procurement/invoice-exceptions): the read model the page draws — who reads it (FINANCE,
// whoever may reject it, the role its open differences are sent to), the labels of where each value came from
// (FR-AP-101 AC5), the lines with the match result (FR-AP-102), the suggestion and its source per line (FR-AP-108 AC1),
// the differences with the role each is sent to and the ways the member may settle them (FR-AP-103 AC1 AC2) — and the
// commands behind its buttons (src/app/(workspace)/finance/invoices/[poId]/ap-commands.ts), which parse the browser's
// input and leave every rule to the S8 services. Real Postgres, organizations of the phase-1 fixtures.

let ap: ApOrg
beforeAll(async () => {
  ap = await apOrg()
})

const as = (code: string) => ap.org.ctxOf(code, AP_NOW)
const versionOf = async (invoiceId: string) => (await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).version
const page = async (code: string, invoiceId: string) => ok(await getApInvoicePage(as(code), invoiceId))

/** Dates far apart so two invoices of the same total are never possible duplicates (BR-MATCH-12) */
let count = 0
const nextDate = () => new Date(Date.UTC(2026, 9, 10 - 5 * ++count)).toISOString().slice(0, 10)

/** A PO of 1 × 1,000.00 received in full, and a submitted invoice priced 1,100.00 on it: PRICE_OVER 100.00 */
async function priceOver() {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice: '1000.00' }])
  await receive(ap, po, { 0: '1' })
  const draft = await codedDraft(ap, po, { no: `PO-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '77.00', lines: [{ line: 0, quantity: '1', unitPrice: '1100.00' }] })
  expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION' })
  return { po, invoiceId: draft.invoiceId }
}

describe('[FR-AP-102/AC1] the page of a draft and who reads it', () => {
  it('FINANCE reads a draft with its lines, the suggestion of each line with its source, and may edit, code, submit and discard it [FR-AP-108/AC1]', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '250.00' }])
    await receive(ap, po, { 0: '2' })
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, { idempotencyKey: randomUUID() }))
    const view = await page('fin_officer', invoiceId)
    expect(view).toMatchObject({ status: 'DRAFT', number: null, po: { id: po.id }, supplier: { id: ap.supplierId }, file: null })
    expect(view.may).toEqual({ edit: true, submit: true, cancel: true, recheck: false, variance: false, dismiss: false, reopen: false, reject: false })
    expect(view.lines).toHaveLength(1)
    expect(view.lines[0]).toMatchObject({ poLineNo: 1, quantity: '2', unitPriceSatang: 25_000n, poUnitPriceSatang: 25_000n, matchStatus: 'PENDING', codingConfirmed: false, budgetCostCenterId: expect.any(String) })
    // BR-AP-10: the code with where it came from — the budget line's, or the history once this supplier has some
    const suggestion = view.lines[0]!.suggestion!
    expect(suggestion.accountCode).toBe('510101')
    expect(suggestion.source === 'BUDGET_LINE' ? suggestion.count === 0 : suggestion.source === 'HISTORY' && suggestion.count > 0).toBe(true)
    expect(view.options.accountCodes.map((c) => c.code)).toEqual(['510101', '530101'])
    expect(view.options.costCenters.length).toBeGreaterThan(0)
    expect(view.events.map((e) => e.type)).toEqual(['invoice.drafted'])
  })

  it('PROCUREMENT reads a draft but may change nothing on it; a member without an invoice role, an auditor and a receiver with nothing sent to them are FORBIDDEN', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '300.00' }])
    await receive(ap, po, { 0: '1' })
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, { idempotencyKey: randomUUID() }))
    const view = await page('proc_officer', invoiceId)
    expect(Object.values(view.may).every((m) => m === false)).toBe(true)
    expect(view.options.accountCodes).toEqual([])
    expect(view.lines[0]!.suggestion).toBeNull()
    for (const code of ['req_con', 'auditor', 'receiver_con']) {
      expect(await getApInvoicePage(as(code), invoiceId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
  })

  it('an id that is no invoice of the organization is NOT_FOUND, so the route shows the PO of that id as before', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '10.00' }])
    expect(await getApInvoicePage(fin(ap), po.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getApInvoicePage(fin(ap), 'not-a-uuid')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('[FR-AP-102/AC6] with module PAY off the page is MODULE_DISABLED and PROCUREMENT’s list too', async () => {
    const off = await apOrg()
    const po = await sentPo(off, [{ quantity: '1', unitPrice: '100.00' }])
    await receive(off, po, { 0: '1' })
    const { invoiceId } = ok(await createInvoice(fin(off), { poId: po.id }, { idempotencyKey: randomUUID() }))
    await prisma.orgModule.updateMany({ where: { organizationId: off.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    expect(await getApInvoicePage(fin(off), invoiceId)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await listVarianceExceptions(off.org.ctxOf('proc_officer', AP_NOW))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[FR-AP-101/AC5] where each value came from', () => {
  it('a draft from an AI reading labels the values the AI gave until a person types over one; its file downloads for whoever reads the invoice only', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '400.00' }])
    await receive(ap, po, { 0: '1' })
    const fileId = (await prisma.fileObject.create({ data: { organizationId: ap.org.organizationId, storageKey: `test/${randomUUID()}.jpg`, fileName: 'invoice.jpg', mimeType: 'image/jpeg', sizeBytes: 1, status: 'AVAILABLE', uploadedById: ap.org.member.fin_officer! } })).id
    const { invoiceId } = ok(await createDraftFromReading(fin(ap), { fileId, poId: po.id, agentActionId: await invoiceReading(ap, po.id), supplierInvoiceNo: 'AI-1', invoiceDate: nextDate(), statedVat: '28.00' }, { idempotencyKey: randomUUID() }))
    const before = await page('fin_officer', invoiceId)
    expect(before.fieldSources).toEqual({ supplierInvoiceNo: 'AI_READING', invoiceDate: 'AI_READING', statedVat: 'AI_READING' })
    expect(before.file).toEqual({ id: fileId, fileName: 'invoice.jpg' })

    // the browser's amounts with thousands separators are cleaned; only what changed is sent
    expect(await updateApInvoiceFor(fin(ap), { invoiceId, version: before.version, supplierInvoiceNo: 'INV-77', discount: '12.345' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'discount', reason: 'AMOUNT' })
    expect(await updateApInvoiceFor(fin(ap), { invoiceId, version: before.version, supplierInvoiceNo: ' INV-77 ' }, randomUUID())).toEqual({ ok: true })
    const after = await page('fin_officer', invoiceId)
    expect(after.supplierInvoiceNo).toBe('INV-77')
    expect(after.fieldSources).toEqual({ invoiceDate: 'AI_READING', statedVat: 'AI_READING' })

    expect((await getDownloadUrl(fin(ap), { fileId })).ok).toBe(true)
    expect(await getDownloadUrl(as('req_con'), { fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-AP-108/AC2] the commands of a draft', () => {
  it('saves the header and lines with the version read, refuses coding without a reason for another cost center and submits only once every line is confirmed', async () => {
    const po = await sentPo(ap, [{ quantity: '4', unitPrice: '1250.00' }])
    await receive(ap, po, { 0: '4' })
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, { idempotencyKey: randomUUID() }))
    let view = await page('fin_officer', invoiceId)
    const stale = view.version
    expect(await updateApInvoiceFor(fin(ap), { invoiceId, version: view.version, supplierInvoiceNo: `S-${randomUUID().slice(0, 6)}`, invoiceDate: nextDate(), statedVat: '350.00', lines: [{ poLineId: po.lines[0]!.id, quantity: '4', unitPrice: '1,250.00' }] }, randomUUID())).toEqual({ ok: true })
    expect(await updateApInvoiceFor(fin(ap), { invoiceId, version: stale, isFinal: true }, randomUUID())).toMatchObject({ ok: false, code: 'CONFLICT_VERSION' })
    view = await page('fin_officer', invoiceId)
    expect(view).toMatchObject({ netSatang: 500_000n, statedVatSatang: 35_000n, grossSatang: 535_000n })

    expect(await submitApInvoiceFor(fin(ap), { invoiceId, version: view.version }, randomUUID())).toMatchObject({ ok: false, code: 'CODING_NOT_CONFIRMED', lines: '1' })
    const line = view.lines[0]!
    const other = await prisma.costCenter.create({ data: { organizationId: ap.org.organizationId, code: `CC-${randomUUID().slice(0, 6)}`, nameTh: 'ศูนย์อื่น', departmentId: (await prisma.costCenter.findUniqueOrThrow({ where: { id: line.budgetCostCenterId } })).departmentId } })
    const reasonMissing = await confirmApCodingFor(fin(ap), { invoiceId, version: view.version, lines: [{ invoiceLineId: line.id, accountCode: '510101', costCenterId: other.id, costCenterReason: '  ' }] }, randomUUID())
    expect(reasonMissing).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'COST_CENTER_REASON_REQUIRED' })
    expect(apErrorKey(reasonMissing as never)).toBe('COST_CENTER_REASON_REQUIRED')
    expect(await confirmApCodingFor(fin(ap), { invoiceId, version: view.version, lines: [{ invoiceLineId: line.id, accountCode: '599999', costCenterId: line.budgetCostCenterId }] }, randomUUID())).toMatchObject({ ok: false, reason: 'ACCOUNT_CODE_UNKNOWN' })
    expect(await confirmApCodingFor(fin(ap), { invoiceId, version: view.version, lines: [{ invoiceLineId: line.id, accountCode: '510101', costCenterId: other.id, costCenterReason: 'งานของไซต์อื่น', whtIncomeTypeCode: '' }] }, randomUUID())).toEqual({ ok: true })
    view = await page('fin_officer', invoiceId)
    expect(view.lines[0]).toMatchObject({ codingConfirmed: true, accountCode: '510101', codingSource: 'BUDGET_LINE', costCenterId: other.id, costCenterReason: 'งานของไซต์อื่น', whtIncomeTypeCode: null })

    const submitted = await submitApInvoiceFor(fin(ap), { invoiceId, version: view.version }, randomUUID())
    expect(submitted).toMatchObject({ ok: true, status: 'READY_FOR_PAYMENT', number: expect.stringMatching(/^AP-/) })
    view = await page('fin_officer', invoiceId)
    expect(view.lines[0]).toMatchObject({ matchStatus: 'MATCHED', expectedNetSatang: 500_000n, overSatang: 0n })
    expect(view.dueDate).not.toBeNull()
    expect(view.may.edit).toBe(false)
    expect(view.events.map((e) => e.type)).toEqual(expect.arrayContaining(['invoice.drafted', 'invoice.updated', 'invoice.coding_confirmed', 'invoice.submitted']))
  })

  it('discards a draft only with a reason; a member without invoice.record is FORBIDDEN and nothing changes', async () => {
    const po = await sentPo(ap, [{ quantity: '1', unitPrice: '90.00' }])
    await receive(ap, po, { 0: '1' })
    const { invoiceId } = ok(await createInvoice(fin(ap), { poId: po.id }, { idempotencyKey: randomUUID() }))
    const version = await versionOf(invoiceId)
    expect(await cancelApInvoiceFor(fin(ap), { invoiceId, version, reason: '   ' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', reason: 'REASON_REQUIRED' })
    expect(await cancelApInvoiceFor(as('proc_officer'), { invoiceId, version, reason: 'ผิดใบ' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await cancelApInvoiceFor(fin(ap), { invoiceId, version, reason: 'ผิดใบ' }, 'not-a-key')).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' })
    expect(await cancelApInvoiceFor(fin(ap), { invoiceId, version, reason: 'ผิดใบ' }, randomUUID())).toEqual({ ok: true })
    const view = await page('fin_officer', invoiceId)
    expect(view).toMatchObject({ status: 'CANCELLED', cancelReason: 'ผิดใบ' })
    expect(view.events.at(-1)).toMatchObject({ type: 'invoice.cancelled', reason: 'ผิดใบ', actor: { th: expect.any(String) } })
  })
})

describe('[FR-AP-103/AC1] [FR-AP-103/AC2] the differences and the ways to settle them', () => {
  it('a price over shows the line over the PO price, sent to PROCUREMENT, with variance approval for PROCUREMENT and recheck, reopen and reject for FINANCE', async () => {
    const { invoiceId } = await priceOver()
    const forFinance = await page('fin_officer', invoiceId)
    expect(forFinance.status).toBe('EXCEPTION')
    expect(forFinance.exceptions).toEqual([expect.objectContaining({ type: 'PRICE_OVER', amountSatang: 10_000n, lineNo: 1, assigneeRole: 'PROCUREMENT', status: 'OPEN' })])
    expect(forFinance.lines[0]).toMatchObject({ matchStatus: 'EXCEPTION', netSatang: 110_000n, expectedNetSatang: 100_000n, overSatang: 10_000n })
    expect(forFinance.may).toMatchObject({ recheck: true, variance: false, dismiss: false, reopen: true, reject: true, edit: false })
    const forProcurement = await page('proc_officer', invoiceId)
    expect(forProcurement.may).toMatchObject({ recheck: true, variance: true, dismiss: false, reopen: false, reject: true })
    // a receiver reads an invoice only when a difference is sent to them
    expect(await getApInvoicePage(as('receiver_con'), invoiceId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // checking again with nothing changed keeps it in EXCEPTION
    expect(await recheckApInvoiceFor(as('proc_officer'), { invoiceId, version: forProcurement.version }, randomUUID())).toEqual({ ok: true, status: 'EXCEPTION' })
  })

  it('S8-14 review: a RECEIVER of another department neither reads the invoice nor downloads its file nor checks it again; with PAY off nobody downloads it', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '650.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `QS-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '91.00', lines: [{ line: 0, quantity: '2', unitPrice: '650.00' }] })
    expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION' })
    const fileId = (await prisma.fileObject.create({ data: { organizationId: ap.org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: ap.org.member.fin_officer! } })).id
    await prisma.fileLink.create({ data: { organizationId: ap.org.organizationId, fileId, subjectType: 'Invoice', subjectId: draft.invoiceId, kind: 'INVOICE' } })
    // a receiver of another department, who received nothing of this PO
    const other = Object.entries(ap.org.department).find(([code]) => code !== 'CON')![1]
    await prisma.roleAssignment.create({ data: { organizationId: ap.org.organizationId, memberId: ap.org.member.vp_sup!, role: 'RECEIVER', scopeDepartmentId: other, grantedAt: AP_NOW } })
    expect(await getApInvoicePage(as('vp_sup'), draft.invoiceId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await getDownloadUrl(as('vp_sup'), { fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await recheckInvoice(as('vp_sup'), { invoiceId: draft.invoiceId, version: await versionOf(draft.invoiceId) }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the receiver of the department that asked for the goods does
    expect((await getDownloadUrl(as('receiver_con'), { fileId })).ok).toBe(true)
    // PAY switched off: not even FINANCE downloads it (BR-AP-13)
    await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: false } })
    try {
      expect(await getDownloadUrl(fin(ap), { fileId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: ap.org.organizationId, module: 'PAY' }, data: { enabled: true } })
    }
  })

  it('a quantity not received is sent to the receiver, who reads the invoice and may check it again', async () => {
    const po = await sentPo(ap, [{ quantity: '2', unitPrice: '700.00' }])
    await receive(ap, po, { 0: '1' })
    const draft = await codedDraft(ap, po, { no: `QR-${randomUUID().slice(0, 6)}`, date: nextDate(), vat: '98.00', lines: [{ line: 0, quantity: '2', unitPrice: '700.00' }] })
    expect(ok(await submit(ap, draft))).toMatchObject({ status: 'EXCEPTION' })
    const view = await page('receiver_con', draft.invoiceId)
    expect(view.exceptions).toEqual([expect.objectContaining({ type: 'QTY_NOT_RECEIVED', assigneeRole: 'RECEIVER' })])
    expect(view.may).toMatchObject({ recheck: true, variance: false, reopen: false, reject: false })
    // not PROCUREMENT's: it is not on their list
    const list = ok(await listVarianceExceptions(as('proc_officer')))
    expect(list.some((r) => r.invoiceId === draft.invoiceId)).toBe(false)
  })

  it('[FR-AP-105/AC2] PROCUREMENT’s list has the price over with what is over; asking for the variance needs a reason and sends it for approval; FINANCE may not see the list', async () => {
    const { invoiceId, po } = await priceOver()
    const row = ok(await listVarianceExceptions(as('proc_officer'))).find((r) => r.invoiceId === invoiceId)
    expect(row).toMatchObject({ po: { id: po.id }, overSatang: 10_000n, types: ['PRICE_OVER'], canRequest: true, supplier: { code: 'S1' } })
    expect(await listVarianceExceptions(fin(ap))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await requestApVarianceFor(as('proc_officer'), { invoiceId, version: row!.version, reason: '' }, randomUUID())).toMatchObject({ ok: false, reason: 'REASON_REQUIRED' })
    expect(await requestApVarianceFor(fin(ap), { invoiceId, version: row!.version, reason: 'ราคาขึ้น' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await requestApVarianceFor(as('proc_officer'), { invoiceId, version: row!.version, reason: 'ราคาขึ้น' }, randomUUID())).toEqual({ ok: true, status: 'PENDING_APPROVAL' })
    const view = await page('proc_officer', invoiceId)
    expect(view).toMatchObject({ status: 'PENDING_APPROVAL', exceptions: [expect.objectContaining({ status: 'ACCEPT_REQUESTED' })] })
    expect(view.may.variance).toBe(false)
    expect(view.events.find((e) => e.type === 'invoice.variance_submitted')).toMatchObject({ reason: 'ราคาขึ้น' })
    expect(ok(await listVarianceExceptions(as('proc_officer'))).some((r) => r.invoiceId === invoiceId)).toBe(false)

    // the approver's inbox names it (S8-13): its number and supplier, not a task without a title
    const waiting = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'INVOICE', subjectId: invoiceId } } }, select: { id: true, assigneeMemberId: true } })
    const approverCode = Object.entries(ap.org.member).find(([, id]) => id === waiting.assigneeMemberId)![0]
    const inbox = await listMyTasks(ap.org.ctxOf(approverCode, AP_NOW))
    expect(inbox.items.find((i) => i.id === waiting.id)?.subject).toEqual({ kind: 'INVOICE', invoiceId, number: view.number, poNumber: po.number, supplierName: 'ผู้ขายหนึ่ง' })
  })

  it('rejecting needs a reason and invoice.reject; a dismissal names an exception', async () => {
    const { invoiceId } = await priceOver()
    const version = await versionOf(invoiceId)
    expect(await rejectApInvoiceFor(as('req_con'), { invoiceId, version, reason: 'ราคาไม่ตรง' }, randomUUID())).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(await rejectApInvoiceFor(fin(ap), { invoiceId, version, reason: ' ' }, randomUUID())).toMatchObject({ ok: false, reason: 'REASON_REQUIRED' })
    expect(await dismissApExceptionFor(fin(ap), { exceptionId: 'x', reason: 'ไม่ซ้ำ' }, randomUUID())).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', field: 'exceptionId' })
    expect(await rejectApInvoiceFor(fin(ap), { invoiceId, version, reason: 'ราคาไม่ตรง' }, randomUUID())).toEqual({ ok: true })
    const view = await page('fin_officer', invoiceId)
    expect(view).toMatchObject({ status: 'REJECTED', rejectReason: 'ราคาไม่ตรง', exceptions: [] })
    expect(Object.values(view.may).every((m) => m === false)).toBe(true)
  })
})
