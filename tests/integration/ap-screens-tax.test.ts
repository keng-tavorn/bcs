import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { releaseRetentionFor } from '@/app/(workspace)/finance/retentions/commands'
import { exportWhtReturnFor, revealPayeeTaxIdFor } from '@/app/(workspace)/finance/wht/commands'
import { confirmIncomeTypeFor, percentToBasisPoints, updateIncomeTypeFor } from '@/app/(workspace)/finance/wht/types/commands'
import { systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { holdInvoicesForPayment, recordInvoicePayment } from '@/server/services/ap/payment'
import { listRetentionsView, listWhtCertificatesView, listWhtIncomeTypesView, monthsUpTo } from '@/server/services/ap/view-tax'
import { confirmIncomeType, updateIncomeType, updateSupplierTaxProfile } from '@/server/services/ap/wht'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'

// S8-13 screens of withholding tax and retention (FR-AP-104 AC2 AC4 AC5, FR-AP-106 AC4): the views behind
// /finance/retentions, /finance/wht and /finance/wht/types and the commands their forms call. An individual payee's
// national id reaches the screen masked; FINANCE opens it whole through a logged action, AUDITOR reads but may not;
// retentions are released from their due date (RETENTION_NOT_DUE says the date in words); a rate typed as a percentage
// becomes basis points on the server and its confirmer is never the member who changed it; PAY off refuses every page.

const INDIVIDUAL_ID = '3100700512345'
let ap: ApOrg
let certificateId: string
const auditor = () => ap.org.ctxOf('auditor', AP_NOW)
const dm = () => ap.org.ctxOf('dm_fin', AP_NOW)
const s9 = () => systemCtx(ap.org.organizationId, AP_NOW, 'payment-run')

let count = 0
/** A SERVICE PO received in full and its invoice ready for payment, each on its own date */
async function readyServiceInvoice(unitPrice: string, vat: string) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice }])
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'SERVICE' } })
  await receive(ap, po, { 0: '1' })
  const date = new Date(Date.UTC(2026, 9, 10 - 4 * ++count)).toISOString().slice(0, 10)
  const draft = await codedDraft(ap, po, { no: `T-${randomUUID().slice(0, 6)}`, date, vat, lines: [{ line: 0, quantity: '1', unitPrice }] })
  expect(ok(await submit(ap, draft)).status).toBe('READY_FOR_PAYMENT')
  return prisma.invoice.findUniqueOrThrow({ where: { id: draft.invoiceId } })
}

async function inS9<T extends { ok: boolean }>(ctx: Ctx, run: (tx: Parameters<Parameters<ReturnType<typeof forTenant>['$transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return forTenant(ap.org.organizationId).$transaction(async (tx) => {
    const r = await run(tx)
    if (r.ok && 'events' in r) await appendEvents(tx, ctx, r.events as never)
    return r
  })
}

beforeAll(async () => {
  ap = await apOrg()
  await prisma.supplier.update({ where: { id: ap.supplierId }, data: { taxId: INDIVIDUAL_ID, nameTh: 'นายสมชาย ช่างดี' } })
  ok(await updateIncomeType(fin(ap), { code: 'SERVICE', nameTh: 'ค่าบริการ', rateBp: 300, form: 'PND3_53', active: true }, key()))
  ok(await confirmIncomeType(dm(), { code: 'SERVICE' }, key()))
  ok(await updateSupplierTaxProfile(fin(ap), { supplierId: ap.supplierId, payeeType: 'INDIVIDUAL', defaultWhtIncomeTypeCode: 'SERVICE' }, key()))
  // one payment: a 50 ทวิ of an individual payee
  const invoice = await readyServiceInvoice('20000.00', '1400.00')
  await inS9(s9(), (tx) => holdInvoicesForPayment(tx, s9(), { invoiceIds: [invoice.id], paymentRunId: randomUUID() }))
  const paid = await inS9(s9(), (tx) =>
    recordInvoicePayment(tx, s9(), { invoiceIds: [invoice.id], retentionIds: [], paymentRunItemId: randomUUID(), paidOn: '2026-10-12', whtLines: [{ incomeType: 'SERVICE', rateBp: 300, baseSatang: 2_000_000n, whtSatang: 60_000n }] }),
  )
  if (!paid.ok) throw new Error(JSON.stringify(paid.error))
  certificateId = paid.certificateId!
})

describe('[FR-AP-104/AC5] /finance/wht: the national id masked, whole only for wht.revealTaxId and logged', () => {
  it('AUDITOR sees the 50 ทวิ with the id masked, no PDF, and may not reveal it', async () => {
    const view = ok(await listWhtCertificatesView(auditor()))
    expect(view).toMatchObject({ canReveal: false, canExport: false })
    const row = view.rows.find((r) => r.id === certificateId)!
    expect(row).toMatchObject({ form: 'PND3', paidOn: '2026-10-12', totalTaxSatang: 60_000n, fileId: null, payee: { individual: true, masked: true, taxId: 'XXXXXXXXX2345' } })
    expect(JSON.stringify(view, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(INDIVIDUAL_ID)
    const before = await prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId } })
    expect(await revealPayeeTaxIdFor(auditor(), { certificateId }, 'th')).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await exportWhtReturnFor(auditor(), { month: '2026-10', form: 'PND3', revealTaxId: false }, randomUUID(), 'th')).toEqual({ ok: false, code: 'FORBIDDEN' })
    expect(await prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId } })).toBe(before)
  })

  it('FINANCE sees it masked too, reveals it formatted with a SensitiveAccessLog row, and gets the PDF', async () => {
    const view = ok(await listWhtCertificatesView(fin(ap)))
    expect(view).toMatchObject({ canReveal: true, canExport: true })
    expect(view.months[0]).toBe('2026-10')
    const row = view.rows.find((r) => r.id === certificateId)!
    expect(row.payee.taxId).toBe('XXXXXXXXX2345')
    expect(row.fileId).not.toBeNull()
    const before = await prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId } })
    expect(await revealPayeeTaxIdFor(fin(ap), { certificateId }, 'th')).toEqual({ ok: true, taxId: '3-1007-00512-34-5' })
    const logs = await prisma.sensitiveAccessLog.findMany({ where: { subjectId: certificateId }, orderBy: { createdAt: 'desc' } })
    expect(logs).toHaveLength(before + 1)
    expect(logs[0]).toMatchObject({ subjectType: 'WhtCertificate', purpose: 'wht.revealTaxId' })
    expect(await revealPayeeTaxIdFor(fin(ap), { certificateId: 'not-an-id' }, 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'INPUT' })
  })

  it('[FR-AP-104/AC4] the monthly summary answers its rows, total and sha256; with ids whole each certificate is logged', async () => {
    const masked = await exportWhtReturnFor(fin(ap), { month: '2026-10', form: 'PND3', revealTaxId: false }, randomUUID(), 'th')
    expect(masked).toMatchObject({ ok: true, rowCount: 1, total: '600.00' })
    if (!masked.ok) throw new Error('export refused')
    expect(masked.checksum).toMatch(/^[0-9a-f]{64}$/)
    const before = await prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId } })
    expect(await exportWhtReturnFor(fin(ap), { month: '2026-10', form: 'PND3', revealTaxId: true }, randomUUID(), 'th')).toMatchObject({ ok: true, rowCount: 1, total: '600.00' })
    expect(await prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId, purpose: 'wht.export' } })).toBeGreaterThanOrEqual(1)
    expect(await prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId } })).toBe(before + 1)
    expect(await exportWhtReturnFor(fin(ap), { month: '2026-13', form: 'PND3', revealTaxId: false }, randomUUID(), 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'MONTH' })
  })

  it('the months offered run back a year from this month', () => {
    expect(monthsUpTo('2026-02-15', 3)).toEqual(['2026-02', '2026-01', '2025-12'])
  })
})

describe('[FR-AP-104/AC2] /finance/wht/types: the rate typed as a percentage, confirmed by another member', () => {
  it('turns the text into basis points without a float', () => {
    expect(['3', '1.5', '0.75', '3%', '100', '0'].map(percentToBasisPoints)).toEqual([300, 150, 75, 300, 10_000, 0])
    expect(['', '1.234', '-1', '100.01', 'abc', '1e2'].map(percentToBasisPoints)).toEqual([null, null, null, null, null, null])
  })

  it('FINANCE adds a type that waits; the member who changed it is refused SOD_VIOLATION; another confirms it', async () => {
    const form = { code: 'rent', nameTh: 'ค่าเช่า', nameEn: '', rate: '1.5', form: 'PND3_53', legalRefTh: '', active: true }
    expect(await updateIncomeTypeFor(fin(ap), { ...form, rate: '1.234' }, randomUUID(), 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'RATE' })
    expect(await updateIncomeTypeFor(fin(ap), { ...form, code: 'ค่าเช่า' }, randomUUID(), 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'CODE' })
    expect(await updateIncomeTypeFor(fin(ap), form, randomUUID(), 'th')).toEqual({ ok: true })
    expect(await prisma.whtIncomeType.findFirstOrThrow({ where: { organizationId: ap.org.organizationId, code: 'RENT' } })).toMatchObject({ rateBp: 150, nameEn: null, legalRefTh: null, confirmedById: null })

    const mine = ok(await listWhtIncomeTypesView(fin(ap)))
    expect(mine.canConfigure).toBe(true)
    expect(mine.rows.find((r) => r.code === 'RENT')).toMatchObject({ rateBp: 150, confirmedBy: null, changedByMe: true })
    expect(await confirmIncomeTypeFor(fin(ap), { code: 'RENT' }, randomUUID(), 'th')).toEqual({ ok: false, code: 'SOD_VIOLATION' })
    expect(await confirmIncomeTypeFor(dm(), { code: 'RENT' }, randomUUID(), 'th')).toEqual({ ok: true })
    const theirs = ok(await listWhtIncomeTypesView(dm()))
    expect(theirs.rows.find((r) => r.code === 'RENT')).toMatchObject({ changedByMe: false, confirmedBy: { th: expect.any(String) } })
  })

  it('AUDITOR reads the types but may not change them', async () => {
    const view = ok(await listWhtIncomeTypesView(auditor()))
    expect(view.canConfigure).toBe(false)
    expect(view.rows.map((r) => r.code)).toContain('SERVICE')
    expect(await updateIncomeTypeFor(auditor(), { code: 'X', nameTh: 'x', nameEn: '', rate: '1', form: 'PND53', legalRefTh: '', active: true }, randomUUID(), 'th')).toEqual({ ok: false, code: 'FORBIDDEN' })
  })
})

describe('[FR-AP-106/AC4] /finance/retentions: released from the due date', () => {
  let due: string
  let notDue: string
  beforeAll(async () => {
    const make = async (releaseDueOn: string) => {
      const invoice = await readyServiceInvoice('5000.00', '350.00')
      return (await prisma.retention.create({ data: { organizationId: ap.org.organizationId, invoiceId: invoice.id, poId: invoice.poId, supplierId: invoice.supplierId, amountSatang: 25_000n, releaseDueOn: new Date(`${releaseDueOn}T00:00:00Z`) } })).id
    }
    due = await make('2026-10-01')
    notDue = await make('2026-11-30')
  })

  it('lists them with their invoice, PO and whether the day has come; PROCUREMENT and AUDITOR are refused', async () => {
    const view = ok(await listRetentionsView(fin(ap)))
    expect(view.today).toBe('2026-10-12')
    expect(view.rows.find((r) => r.id === due)).toMatchObject({ status: 'HELD', due: true, releaseDueOn: '2026-10-01', amountSatang: 25_000n, po: { number: expect.any(String) } })
    expect(view.rows.find((r) => r.id === notDue)).toMatchObject({ status: 'HELD', due: false, releaseDueOn: '2026-11-30' })
    expect(await listRetentionsView(ap.org.ctxOf('proc_officer', AP_NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await listRetentionsView(auditor())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('before the day: RETENTION_NOT_DUE with the date in words; from the day: released with the row’s version', async () => {
    const version = (id: string) => prisma.retention.findUniqueOrThrow({ where: { id } }).then((r) => r.version)
    expect(await releaseRetentionFor(fin(ap), { retentionId: notDue, version: await version(notDue) }, randomUUID(), 'th')).toEqual({ ok: false, code: 'RETENTION_NOT_DUE', date: '30 พ.ย. 2569' })
    expect(await releaseRetentionFor(fin(ap), { retentionId: notDue, version: await version(notDue) }, randomUUID(), 'en')).toEqual({ ok: false, code: 'RETENTION_NOT_DUE', date: '30 Nov 2569' })
    expect(await releaseRetentionFor(fin(ap), { retentionId: due, version: (await version(due)) + 1 }, randomUUID(), 'th')).toEqual({ ok: false, code: 'CONFLICT_VERSION' })
    expect(await releaseRetentionFor(fin(ap), { retentionId: due, version: await version(due) }, randomUUID(), 'th')).toEqual({ ok: true })
    expect(ok(await listRetentionsView(fin(ap))).rows.find((r) => r.id === due)).toMatchObject({ status: 'RELEASABLE' })
    expect(await releaseRetentionFor(fin(ap), { retentionId: due, version: 0 }, 'not-a-key', 'th')).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'INPUT' })
  })
})

describe('[FR-AP-106/AC5] [FR-AP-104/AC5] PAY switched off: every tax page refuses', () => {
  it('the three views say MODULE_DISABLED and releasing is refused', async () => {
    const off = await apOrg({ modules: [] })
    const ctx = fin(off)
    expect(await listRetentionsView(ctx)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await listWhtCertificatesView(ctx)).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await listWhtIncomeTypesView(off.org.ctxOf('auditor', AP_NOW))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await releaseRetentionFor(ctx, { retentionId: randomUUID(), version: 0 }, randomUUID(), 'th')).toEqual({ ok: false, code: 'MODULE_DISABLED' })
  })
})
