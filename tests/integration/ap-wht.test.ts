import { createHash, randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readObject } from '@/integrations/storage'
import { createLogger, logger } from '@/lib/logger'
import { OrgSettingsSchema } from '@/lib/org-settings'
import { systemCtx, type Ctx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { appendEvents } from '@/server/events/append'
import { rejectInvoice } from '@/server/services/ap/exceptions'
import { holdInvoicesForPayment, recordInvoicePayment, releaseInvoicesFromPayment, type WhtLineInput } from '@/server/services/ap/payment'
import { confirmIncomeType, updateIncomeType, updateSupplierTaxProfile } from '@/server/services/ap/wht'
import { exportWhtReturn, WHT_RETURN_NOTICE } from '@/server/services/ap/wht-export'
import { revealWhtPayeeTaxId } from '@/server/services/ap/wht-files'
import { getDownloadUrl } from '@/server/services/files'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, sentPo, submit, type ApOrg } from '../support/ap'
import { paymentItemOf } from '../support/pay'

// S8-08 (FR-AP-104, BR-WHT-03 to BR-WHT-10, ADR-127): the income types FINANCE sets and another FINANCE member confirms,
// the expected tax of a ready invoice, what S9 does to invoices inside its own transaction (hold, release, and the one
// function that records a payment with its WithholdingTax rows and one 50 ทวิ), the monthly summary file, and the
// national id of an individual payee: masked, whole only with wht.revealTaxId and a SensitiveAccessLog row each time.

const INDIVIDUAL_ID = '3100700512345'

let juristic: ApOrg
let individual: ApOrg
const dm = (ap: ApOrg) => ap.org.ctxOf('dm_fin', AP_NOW)

/** SERVICE at 3% for either payee, confirmed by a second FINANCE member; the supplier withholds SERVICE by default */
async function setUpWht(ap: ApOrg, payeeType: 'JURISTIC' | 'INDIVIDUAL') {
  ok(await updateIncomeType(fin(ap), { code: 'SERVICE', nameTh: 'ค่าบริการ', rateBp: 300, form: 'PND3_53', active: true }, key()))
  ok(await confirmIncomeType(dm(ap), { code: 'SERVICE' }, key()))
  ok(await updateSupplierTaxProfile(fin(ap), { supplierId: ap.supplierId, payeeType, defaultWhtIncomeTypeCode: 'SERVICE' }, key()))
}

beforeAll(async () => {
  juristic = await apOrg()
  await setUpWht(juristic, 'JURISTIC')
  individual = await apOrg()
  await prisma.supplier.update({ where: { id: individual.supplierId }, data: { taxId: INDIVIDUAL_ID, nameTh: 'นายสมชาย ช่างดี' } })
  await setUpWht(individual, 'INDIVIDUAL')
})

let count = 0
/** A SERVICE PO confirmed in full and its invoice ready for payment; each on its own date (never a possible duplicate) */
async function readyServiceInvoice(ap: ApOrg, unitPrice: string, vat: string) {
  const po = await sentPo(ap, [{ quantity: '1', unitPrice }])
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'SERVICE' } })
  await receive(ap, po, { 0: '1' })
  const date = new Date(Date.UTC(2026, 9, 10 - 4 * ++count)).toISOString().slice(0, 10)
  const draft = await codedDraft(ap, po, { no: `W-${randomUUID().slice(0, 6)}`, date, vat, lines: [{ line: 0, quantity: '1', unitPrice }] })
  expect(ok(await submit(ap, draft)).status).toBe('READY_FOR_PAYMENT')
  return draft.invoiceId
}

/** S9's transaction: the function and the events it returns appended, as S9's command does */
async function inS9<T extends { ok: boolean }>(ap: ApOrg, ctx: Ctx, run: (tx: Parameters<Parameters<ReturnType<typeof forTenant>['$transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return forTenant(ap.org.organizationId).$transaction(async (tx) => {
    const r = await run(tx)
    if (r.ok && 'events' in r) await appendEvents(tx, ctx, r.events as never)
    return r
  })
}
const s9 = (ap: ApOrg) => systemCtx(ap.org.organizationId, AP_NOW, 'payment-run')

describe('[FR-AP-104/AC2] income types and the expected tax', () => {
  it('the member who changed a rate does not confirm it; PROCUREMENT does not configure; the timing is AT_PAYMENT only', async () => {
    ok(await updateIncomeType(fin(juristic), { code: 'RENT', nameTh: 'ค่าเช่า', rateBp: 500, form: 'PND3_53', active: true }, key()))
    expect(await confirmIncomeType(fin(juristic), { code: 'RENT' }, key())).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION' } })
    ok(await confirmIncomeType(dm(juristic), { code: 'RENT' }, key()))
    expect(await prisma.whtIncomeType.findFirstOrThrow({ where: { organizationId: juristic.org.organizationId, code: 'RENT' } })).toMatchObject({ confirmedById: juristic.org.member.dm_fin })
    // a change waits for a confirmation again
    ok(await updateIncomeType(fin(juristic), { code: 'RENT', nameTh: 'ค่าเช่า', rateBp: 500, form: 'PND3_53', active: true }, key()))
    expect(await prisma.whtIncomeType.findFirstOrThrow({ where: { organizationId: juristic.org.organizationId, code: 'RENT' } })).toMatchObject({ confirmedById: null })
    expect(await updateIncomeType(juristic.org.ctxOf('proc_officer', AP_NOW), { code: 'X', nameTh: 'x', rateBp: 100, form: 'PND53', active: true }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(OrgSettingsSchema.shape.wht.safeParse({ timing: 'AT_INVOICE' }).success).toBe(false)
  })

  it('a ready SERVICE invoice expects 3% of its amount before VAT, and the ready e-mail carries it', async () => {
    const invoiceId = await readyServiceInvoice(juristic, '10000.00', '700.00')
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } })
    expect(invoice).toMatchObject({ payableSatang: 1_070_000n, expectedWhtSatang: 30_000n })
    expect(invoice.lines[0]!.whtIncomeTypeCode).toBe('SERVICE')
    const notice = await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: invoiceId, templateKey: 'supplier.invoice_ready' } })
    expect(notice.data).toMatchObject({ expectedWhtSatang: '30000' })
  })

  it('an inactive income type stops the submit WHT_TYPE_NOT_CONFIGURED; a type of the other return does not fit the payee', async () => {
    ok(await updateIncomeType(fin(juristic), { code: 'OLD', nameTh: 'เลิกใช้', rateBp: 100, form: 'PND3_53', active: true }, key()))
    const po = await sentPo(juristic, [{ quantity: '1', unitPrice: '5000.00' }])
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { kind: 'SERVICE' } })
    await receive(juristic, po, { 0: '1' })
    const draft = await codedDraft(juristic, po, { no: `O-${randomUUID().slice(0, 6)}`, date: '2026-07-01', vat: '350.00', lines: [{ line: 0, quantity: '1', unitPrice: '5000.00' }] })
    await prisma.invoiceLine.updateMany({ where: { invoiceId: draft.invoiceId }, data: { whtIncomeTypeCode: 'OLD' } })
    ok(await updateIncomeType(fin(juristic), { code: 'OLD', nameTh: 'เลิกใช้', rateBp: 100, form: 'PND3_53', active: false }, key()))
    expect(await submit(juristic, draft)).toMatchObject({ ok: false, error: { code: 'WHT_TYPE_NOT_CONFIGURED', details: { code: 'OLD' } } })
    ok(await updateIncomeType(fin(individual), { code: 'INSURE', nameTh: 'เบี้ยประกัน', rateBp: 100, form: 'PND53', active: true }, key()))
    expect(await updateSupplierTaxProfile(fin(individual), { supplierId: individual.supplierId, payeeType: 'INDIVIDUAL', defaultWhtIncomeTypeCode: 'INSURE' }, key())).toMatchObject({ ok: false, error: { code: 'WHT_FORM_PAYEE_MISMATCH' } })
  })
})

describe('[FR-AP-104/AC3] [BR-AP-12] S9 holds, lets go and records a payment through S8', () => {
  it('held invoices refuse S8 commands; the payment writes one row per group per invoice and one 50 ทวิ whose tax is their sum', async () => {
    // two invoices of 1,000.50: the tax is rounded once for the group (60.03), not per invoice (60.04) — GC-WHT-19
    const a = await readyServiceInvoice(juristic, '1000.50', '70.04')
    const b = await readyServiceInvoice(juristic, '1000.50', '70.04')
    const runId = randomUUID()
    expect(await inS9(juristic, s9(juristic), (tx) => holdInvoicesForPayment(tx, s9(juristic), { invoiceIds: [a, b], paymentRunId: runId }))).toMatchObject({ ok: true })
    expect(await rejectInvoice(fin(juristic), { invoiceId: a, version: (await prisma.invoice.findUniqueOrThrow({ where: { id: a } })).version, reason: 'x' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    await inS9(juristic, s9(juristic), (tx) => releaseInvoicesFromPayment(tx, s9(juristic), { invoiceIds: [b], paymentRunId: runId }))
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: b } })).status).toBe('READY_FOR_PAYMENT')
    await inS9(juristic, s9(juristic), (tx) => holdInvoicesForPayment(tx, s9(juristic), { invoiceIds: [b], paymentRunId: runId }))

    const itemId = await paymentItemOf(juristic, juristic.supplierId)
    const lines: WhtLineInput[] = [{ incomeType: 'SERVICE', rateBp: 300, baseSatang: 200_100n, whtSatang: 6_003n }]
    const wrong = await inS9(juristic, s9(juristic), (tx) => recordInvoicePayment(tx, s9(juristic), { invoiceIds: [a, b], retentionIds: [], paymentRunItemId: itemId, paidOn: '2026-10-12', whtLines: [{ ...lines[0]!, whtSatang: 6_004n }] }))
    expect(wrong).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'WHT_MISMATCH' } } })
    const paid = await inS9(juristic, s9(juristic), (tx) => recordInvoicePayment(tx, s9(juristic), { invoiceIds: [a, b], retentionIds: [], paymentRunItemId: itemId, paidOn: '2026-10-12', whtLines: lines }))
    if (!paid.ok) throw new Error(JSON.stringify(paid.error))
    expect(paid.whtSatang).toBe(6_003n)
    const certificate = await prisma.whtCertificate.findUniqueOrThrow({ where: { id: paid.certificateId! } })
    const rows = await prisma.withholdingTax.findMany({ where: { certificateId: certificate.id }, orderBy: { taxSatang: 'desc' } })
    expect(rows.map((r) => r.taxSatang)).toEqual([3_002n, 3_001n])
    expect(rows.reduce((s, r) => s + r.taxSatang, 0n)).toBe(certificate.totalTaxSatang)
    expect(certificate).toMatchObject({ form: 'PND53', totalBaseSatang: 200_100n, totalTaxSatang: 6_003n })
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: certificate.fileId! } })
    expect(new TextDecoder('latin1').decode((await readObject(file.storageKey)).subarray(0, 5))).toBe('%PDF-')
    expect(await prisma.invoice.count({ where: { id: { in: [a, b] }, status: 'PAID' } })).toBe(2)
    // once per payment item: the invoices are PAID, a second record is refused
    expect(await inS9(juristic, s9(juristic), (tx) => recordInvoicePayment(tx, s9(juristic), { invoiceIds: [a, b], retentionIds: [], paymentRunItemId: itemId, paidOn: '2026-10-12', whtLines: lines }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_STATE_TRANSITION' },
    })
  })

  it('PAY switched off: MODULE_DISABLED', async () => {
    const off = await apOrg({ modules: [] })
    const ctx = systemCtx(off.org.organizationId, AP_NOW, 'payment-run')
    expect(await forTenant(off.org.organizationId).$transaction((tx) => holdInvoicesForPayment(tx, ctx, { invoiceIds: [randomUUID()], paymentRunId: randomUUID() }))).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await updateIncomeType(fin(off), { code: 'SERVICE', nameTh: 'ค่าบริการ', rateBp: 300, form: 'PND3_53', active: true }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

/** The JSON lines the app logs while `run` runs (the app's serializers and redaction) */
async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = []
  const sink = createLogger(new Writable({ write: (chunk, _e, done) => (lines.push(String(chunk)), done()) }), 'trace')
  const spies = [vi.spyOn(logger, 'child').mockImplementation(((b, o) => sink.child(b, o)) as typeof logger.child)]
  for (const level of ['info', 'warn', 'error', 'debug'] as const) spies.push(vi.spyOn(logger, level).mockImplementation(((...a: unknown[]) => (sink[level] as (...x: unknown[]) => void)(...a)) as never) as never)
  try {
    // the capture itself works: this line is in it
    logger.info({ probe: true }, 'log capture probe')
    await run()
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
  return lines.join('\n')
}
afterEach(() => vi.restoreAllMocks())

describe('[FR-AP-104/AC4] [FR-AP-104/AC5] the individual payee: the summary file, the national id and the logs', () => {
  let certificateId: string
  let exportJobId: string
  let logged = ''
  beforeAll(async () => {
    const invoiceId = await readyServiceInvoice(individual, '20000.00', '1400.00')
    const ctx = s9(individual)
    logged = await logsOf(async () => {
      await inS9(individual, ctx, (tx) => holdInvoicesForPayment(tx, ctx, { invoiceIds: [invoiceId], paymentRunId: randomUUID() }))
      const paymentRunItemId = await paymentItemOf(individual, individual.supplierId)
      const paid = await inS9(individual, ctx, (tx) => recordInvoicePayment(tx, ctx, { invoiceIds: [invoiceId], retentionIds: [], paymentRunItemId, paidOn: '2026-10-12', whtLines: [{ incomeType: 'SERVICE', rateBp: 300, baseSatang: 2_000_000n, whtSatang: 60_000n }] }))
      if (!paid.ok) throw new Error(JSON.stringify(paid.error))
      certificateId = paid.certificateId!
      exportJobId = ok(await exportWhtReturn(fin(individual), { month: '2026-10', form: 'PND3' }, key())).exportJobId
      ok(await revealWhtPayeeTaxId(fin(individual), { certificateId }))
    })
  })

  it('[FR-AP-104/AC4] the PND3 file says it is not the Revenue Department format; its total is the sum of its rows and its sha256 is the file', async () => {
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: exportJobId }, include: { file: true } })
    const bytes = await readObject(job.file!.storageKey)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(job.checksum)
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, '')
    const lines = text.trim().split(/\r?\n/)
    expect(lines[0]).toContain(WHT_RETURN_NOTICE)
    const rows = lines.slice(2, -1).map((l) => l.split(','))
    expect(rows).toHaveLength(job.rowCount!)
    const sum = rows.reduce((s, r) => s + BigInt(r[9]!.replace('.', '')), 0n)
    expect(sum).toBe(job.totalSatang)
    expect(lines.at(-1)!.split(',').at(-1)).toBe('600.00')
    // masked: all but the last four digits
    expect(text).not.toContain(INDIVIDUAL_ID)
    expect(text).toContain('2345')
  })

  it('[FR-AP-104/AC5] the id whole needs wht.revealTaxId and leaves a SensitiveAccessLog row each time', async () => {
    const logs = () => prisma.sensitiveAccessLog.count({ where: { subjectId: certificateId } })
    const before = await logs()
    expect(ok(await revealWhtPayeeTaxId(fin(individual), { certificateId })).taxId).toBe(INDIVIDUAL_ID)
    expect(await logs()).toBe(before + 1)
    for (const code of ['auditor', 'proc_officer']) expect(await revealWhtPayeeTaxId(individual.org.ctxOf(code, AP_NOW), { certificateId })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    // the 50 ทวิ prints the id whole: the AUDITOR (wht.view) may not take it, FINANCE may and is logged
    const certificate = await prisma.whtCertificate.findUniqueOrThrow({ where: { id: certificateId } })
    expect(await getDownloadUrl(individual.org.ctxOf('auditor', AP_NOW), { fileId: certificate.fileId! })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    ok(await getDownloadUrl(fin(individual), { fileId: certificate.fileId! }))
    expect(await logs()).toBe(before + 2)
    // a file with the ids whole: only with wht.revealTaxId, and its certificates are logged
    expect(await exportWhtReturn(individual.org.ctxOf('auditor', AP_NOW), { month: '2026-10', form: 'PND3', revealTaxId: true }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const whole = ok(await exportWhtReturn(fin(individual), { month: '2026-10', form: 'PND3', revealTaxId: true }, key()))
    expect(await logs()).toBe(before + 3)
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: whole.exportJobId }, include: { file: true } })
    expect(new TextDecoder().decode(await readObject(job.file!.storageKey))).toContain(INDIVIDUAL_ID)
  })

  it('[NFR-SEC-09] the national id is in no log line, no event and no notice', async () => {
    expect(logged).toContain('log capture probe')
    expect(logged).not.toContain(INDIVIDUAL_ID)
    const events = await prisma.event.findMany({ where: { organizationId: individual.org.organizationId, type: { in: ['wht_certificate.issued', 'withholding_tax.recorded', 'invoice.paid', 'export.generated'] } } })
    expect(JSON.stringify(events.map((e) => e.data))).not.toContain(INDIVIDUAL_ID)
  })
})
