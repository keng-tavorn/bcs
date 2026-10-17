import { createHash } from 'node:crypto'
import { formatSatang } from '@/core/money/format'
import { INVOICE_MACHINE, transition, type InvoiceState } from '@/core/state-machines'
import { bahtText } from '@/core/thai/baht-text'
import { formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { paymentWithholding, returnForm, type WhtLine } from '@/core/wht'
import { putObject } from '@/integrations/storage'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { renderWhtCertificatePdf } from '@/server/pdf/render'
import { issueDocumentNumber } from '../numbering'
import { requireModule } from '../modules'
import { fail, type Fail } from './common'
import { lockRetentions } from './retention'
import { invoiceWhtLines, retentionWhtLines } from './wht'

// What S9 does to tier-2 invoices, inside the transaction of its own command (ADR-127, BR-AP-12, docs/sub-specs/S8.md
// "interface"): a payment run holds READY_FOR_PAYMENT invoices (IN_PAYMENT_RUN) and lets them go again; a paid payment
// item records the payment of its invoices once — recordInvoicePayment is the only function that does, so the tax and
// its 50 ทวิ are written exactly once per payment item. The tax is withheld at payment (OQ-122): S9 sends the lines it
// worked out, and they must be the ones paymentWithholding gives for the documents (WHT_MISMATCH otherwise). Each
// function returns the events of S8; S9 appends them with its own. Released retentions are paid in the same function
// (./retention.ts holds and lets them go).

const HEAD_OFFICE = '00000'
const FORM_TEXT = { PND3: 'ภ.ง.ด.3', PND53: 'ภ.ง.ด.53' } as const

type Moved = { ok: true; events: EventDraft[] } | Fail

/** The invoices locked in id order and checked against the state machine for `command` */
async function lockInvoices(tx: TenantTx, ctx: Ctx, invoiceIds: readonly string[], command: 'invoice.hold_for_payment' | 'invoice.release_from_payment' | 'invoice.record_payment') {
  const pay = await requireModule(ctx, 'PAY', tx)
  if (!pay.ok) return { ok: false as const, error: pay.error }
  const ids = [...new Set(invoiceIds)].sort()
  if (ids.length === 0 || ids.length !== invoiceIds.length) return fail('VALIDATION_FAILED', 'name each invoice once', { field: 'invoiceIds', reason: ids.length ? 'TWICE' : 'REQUIRED' })
  const locked = await lockRowsForUpdate(tx, 'Invoice', ctx.organizationId, ids)
  if (locked.length !== ids.length) return fail('NOT_FOUND', 'invoice not found')
  const invoices = await tx.invoice.findMany({ where: { id: { in: ids } }, orderBy: { number: 'asc' } })
  for (const invoice of invoices) {
    if (invoice.kind !== 'INVOICE') return fail('VALIDATION_FAILED', 'only an invoice is paid in phase 1', { field: 'invoiceIds', reason: 'NOT_AN_INVOICE' })
    if (!transition(INVOICE_MACHINE, invoice.status as InvoiceState, command).ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${invoice.status}`, { from: invoice.status, command, invoiceId: invoice.id })
  }
  return { ok: true as const, invoices }
}

/** A payment run takes READY_FOR_PAYMENT invoices: IN_PAYMENT_RUN, so no S8 command changes them (BR-AP-12) */
export async function holdInvoicesForPayment(tx: TenantTx, ctx: Ctx, input: { readonly invoiceIds: readonly string[]; readonly paymentRunId: string }): Promise<Moved> {
  const locked = await lockInvoices(tx, ctx, input.invoiceIds, 'invoice.hold_for_payment')
  if (!locked.ok) return locked
  await tx.invoice.updateMany({ where: { id: { in: locked.invoices.map((i) => i.id) } }, data: { status: 'IN_PAYMENT_RUN', version: { increment: 1 } } })
  return { ok: true, events: locked.invoices.map((i) => ({ type: 'invoice.payment_held', aggregateType: 'Invoice', aggregateId: i.id, data: { paymentRunId: input.paymentRunId } })) }
}

/**
 * The run lets them go (cancelled, or an item left out): READY_FOR_PAYMENT again. The event names the run; why it let
 * them go is free text the run keeps (its link, its cancel reason or a Comment), never Event.data (BR-BANK-08)
 */
export async function releaseInvoicesFromPayment(tx: TenantTx, ctx: Ctx, input: { readonly invoiceIds: readonly string[]; readonly paymentRunId: string }): Promise<Moved> {
  const locked = await lockInvoices(tx, ctx, input.invoiceIds, 'invoice.release_from_payment')
  if (!locked.ok) return locked
  await tx.invoice.updateMany({ where: { id: { in: locked.invoices.map((i) => i.id) } }, data: { status: 'READY_FOR_PAYMENT', version: { increment: 1 } } })
  return { ok: true, events: locked.invoices.map((i) => ({ type: 'invoice.payment_released', aggregateType: 'Invoice', aggregateId: i.id, data: { paymentRunId: input.paymentRunId } })) }
}

export interface WhtLineInput {
  readonly incomeType: string
  readonly rateBp: number
  readonly baseSatang: bigint
  readonly whtSatang: bigint
}

export interface RecordInvoicePaymentInput {
  readonly invoiceIds: readonly string[]
  /** S8-09: the retentions paid in the same item */
  readonly retentionIds: readonly string[]
  /** S9's payment item: the WithholdingTax rows and the 50 ทวิ of the payment belong to it */
  readonly paymentRunItemId: string
  /** The date of the payment (YYYY-MM-DD, Thai calendar day) */
  readonly paidOn: string
  /** The tax groups S9 worked out for the item */
  readonly whtLines: readonly WhtLineInput[]
}

export interface RecordedPayment {
  readonly ok: true
  readonly events: EventDraft[]
  readonly whtSatang: bigint
  readonly certificateId: string | null
}

/**
 * BR-WHT-07, BR-WHT-10, FR-AP-104 AC3: one payment item of one supplier paid. Its invoices become PAID; the tax of the
 * item is paymentWithholding of their bases (S9's lines must be the same, WHT_MISMATCH otherwise), written as one
 * WithholdingTax row per group per document, and when anything is withheld one 50 ทวิ with its number (WHT_CERT) and
 * its PDF. The sum of the rows is the certificate's tax to the satang.
 */
export async function recordInvoicePayment(tx: TenantTx, ctx: Ctx, input: RecordInvoicePaymentInput): Promise<RecordedPayment | Fail> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) return fail('VALIDATION_FAILED', 'the date paid is a calendar day', { field: 'paidOn', reason: 'FORMAT' })
  if (input.invoiceIds.length === 0 && input.retentionIds.length === 0) return fail('VALIDATION_FAILED', 'a payment item pays at least one document', { field: 'invoiceIds', reason: 'REQUIRED' })
  const lockedInvoices = input.invoiceIds.length ? await lockInvoices(tx, ctx, input.invoiceIds, 'invoice.record_payment') : { ok: true as const, invoices: [] }
  if (!lockedInvoices.ok) return lockedInvoices
  const lockedRetentions = input.retentionIds.length ? await lockRetentions(tx, ctx, input.retentionIds, 'retention.record_payment') : { ok: true as const, rows: [] }
  if (!lockedRetentions.ok) return lockedRetentions
  const invoices = lockedInvoices.invoices
  // the order of the documents in the payment: invoices by number, then retentions by their invoice's number
  const retentions = [...lockedRetentions.rows].sort((a, b) => ((a.invoice.number ?? '') < (b.invoice.number ?? '') ? -1 : 1))
  const supplierId = invoices[0]?.supplierId ?? retentions[0]!.supplierId
  if ([...invoices, ...retentions].some((d) => d.supplierId !== supplierId)) return fail('VALIDATION_FAILED', 'one payment item pays one supplier', { field: 'invoiceIds', reason: 'SUPPLIERS' })

  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true, legalNameTh: true, taxId: true, branchCode: true, address: true } })
  const bases = await invoiceWhtLines(tx, org.settings, invoices.map((i) => i.id))
  const retentionBases = await retentionWhtLines(tx, org.settings, retentions)
  const lines: WhtLine[] = [...invoices.flatMap((i) => bases.get(i.id) ?? []), ...retentions.flatMap((r) => retentionBases.get(r.id) ?? [])]
  const retentionIds = new Set(retentions.map((r) => r.id))
  const tax = paymentWithholding(lines)
  if (!tax.ok) return fail('VALIDATION_FAILED', 'a withholding base is below zero', { reason: tax.reason })
  const expected = tax.groups.map((g) => `${g.incomeType}|${g.rateBp}|${g.baseSatang}|${g.whtSatang}`).sort()
  const sent = input.whtLines.map((g) => `${g.incomeType}|${g.rateBp}|${g.baseSatang}|${g.whtSatang}`).sort()
  if (expected.join('\n') !== sent.join('\n')) return fail('VALIDATION_FAILED', 'the tax lines are not the tax of these documents', { field: 'whtLines', reason: 'WHT_MISMATCH' })

  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { nameTh: true, taxId: true, branchCode: true, address: true, payeeType: true } })
  const types = await tx.whtIncomeType.findMany({ where: { code: { in: tax.groups.map((g) => g.incomeType) } }, select: { code: true, nameTh: true, form: true } })
  for (const g of tax.groups) {
    const type = types.find((t) => t.code === g.incomeType)!
    const form = returnForm(supplier.payeeType, type.form)
    if (!form.ok) return form.code === 'WHT_FORM_PAYEE_MISMATCH' ? fail('WHT_FORM_PAYEE_MISMATCH', `income type ${g.incomeType} is not for a ${supplier.payeeType} payee`, { code: g.incomeType, payeeType: supplier.payeeType }) : fail('VALIDATION_FAILED', 'a foreign payee is outside phase 1', { field: 'payeeType', reason: 'FOREIGN_PAYEE' })
  }
  const form = supplier.payeeType === 'INDIVIDUAL' ? 'PND3' : 'PND53'
  const paidOn = new Date(`${input.paidOn}T00:00:00Z`)
  const events: EventDraft[] = []

  // 50 ทวิ when anything is withheld (BR-WHT-07): one per payment item, its number, its PDF
  let certificateId: string | null = null
  if (tax.whtSatang > 0n) {
    certificateId = newId()
    const number = await issueDocumentNumber(tx, ctx, { document: 'WHT_CERT' })
    const paidBase = tax.groups.reduce((a, g) => a + g.baseSatang, 0n)
    const branch = (code: string) => (code === HEAD_OFFICE ? 'สำนักงานใหญ่' : `สาขา ${code}`)
    const payee = { name: supplier.nameTh, taxId: supplier.taxId ?? '', branch: branch(supplier.branchCode), address: supplier.address ?? '', payeeType: supplier.payeeType }
    const payer = { name: org.legalNameTh, taxId: org.taxId, branch: branch(org.branchCode), address: org.address ?? '' }
    // its order in the month's return: the certificates of the same form already issued for that month, plus one
    const monthStart = new Date(Date.UTC(paidOn.getUTCFullYear(), paidOn.getUTCMonth(), 1))
    const monthEnd = new Date(Date.UTC(paidOn.getUTCFullYear(), paidOn.getUTCMonth() + 1, 1))
    const orderInForm = (await tx.whtCertificate.count({ where: { form, paidOn: { gte: monthStart, lt: monthEnd } } })) + 1
    const pdf = await renderWhtCertificatePdf({
      number,
      payer,
      payee,
      formText: FORM_TEXT[form],
      orderInForm,
      rows: tax.groups.map((g) => ({ incomeType: `${types.find((t) => t.code === g.incomeType)!.nameTh} (${g.rateBp / 100}%)`, paidOnText: formatThaiDate(paidOn), paid: formatSatang(g.baseSatang), tax: formatSatang(g.whtSatang) })),
      totals: { paid: formatSatang(paidBase), tax: formatSatang(tax.whtSatang), taxText: bahtText(tax.whtSatang) },
      issuedText: formatThaiDateTime(ctx.now),
    })
    const fileId = newId()
    const key = `org/${ctx.organizationId}/wht-certificates/${certificateId}.pdf`
    await putObject(key, pdf, 'application/pdf')
    await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey: key, fileName: `50twi-${number.replace(/\//g, '-')}.pdf`, mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), status: 'AVAILABLE', uploadedById: null, scanStatus: 'NOT_REQUIRED' } })
    await tx.whtCertificate.create({
      data: { id: certificateId, organizationId: ctx.organizationId, number, supplierId, form, paidOn, totalBaseSatang: paidBase, totalTaxSatang: tax.whtSatang, payeeSnapshot: payee, payerSnapshot: payer, fileId, issuedAt: ctx.now, paymentRunItemId: input.paymentRunItemId },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'WhtCertificate', subjectId: certificateId, kind: 'WHT_CERT' } })
    // never the payee's tax id in an event (BR-WHT-09)
    events.push({ type: 'wht_certificate.issued', aggregateType: 'WhtCertificate', aggregateId: certificateId, data: { number, supplierId, form, paidOn: input.paidOn, totalBaseSatang: paidBase.toString(), totalTaxSatang: tax.whtSatang.toString(), fileId, paymentRunItemId: input.paymentRunItemId } })
  }

  // one row per group per document; the rows of a certificate add up to its tax
  for (const g of tax.groups) {
    for (const d of g.docs) {
      const id = newId()
      const base = lines.find((l) => l.doc === d.doc && l.incomeType === g.incomeType && l.rateBp === g.rateBp)!.baseSatang
      const document = retentionIds.has(d.doc) ? { invoiceId: null, retentionId: d.doc } : { invoiceId: d.doc, retentionId: null }
      await tx.withholdingTax.create({
        data: { id, organizationId: ctx.organizationId, ...document, supplierId, payeeType: supplier.payeeType, incomeTypeCode: g.incomeType, form, rateBp: g.rateBp, baseSatang: base, taxSatang: d.whtSatang, paidOn, certificateId, paymentRunItemId: input.paymentRunItemId },
      })
      events.push({ type: 'withholding_tax.recorded', aggregateType: 'WithholdingTax', aggregateId: id, data: { ...document, incomeTypeCode: g.incomeType, rateBp: g.rateBp, baseSatang: base.toString(), taxSatang: d.whtSatang.toString(), certificateId } })
    }
  }

  const withheldFrom = (doc: string) => tax.groups.flatMap((g) => g.docs).filter((d) => d.doc === doc).reduce((a, d) => a + d.whtSatang, 0n)
  if (invoices.length) await tx.invoice.updateMany({ where: { id: { in: invoices.map((i) => i.id) } }, data: { status: 'PAID', version: { increment: 1 } } })
  for (const i of invoices) {
    const withheld = withheldFrom(i.id)
    events.push({ type: 'invoice.paid', aggregateType: 'Invoice', aggregateId: i.id, data: { paymentRunItemId: input.paymentRunItemId, paidOn: input.paidOn, payableSatang: i.payableSatang.toString(), whtSatang: withheld.toString(), transferSatang: (i.payableSatang - withheld).toString() } })
  }
  if (retentions.length) await tx.retention.updateMany({ where: { id: { in: retentions.map((r) => r.id) } }, data: { status: 'PAID', paidAt: ctx.now, version: { increment: 1 } } })
  for (const r of retentions) {
    const withheld = withheldFrom(r.id)
    events.push({ type: 'retention.paid', aggregateType: 'Retention', aggregateId: r.id, data: { paymentRunItemId: input.paymentRunItemId, paidOn: input.paidOn, amountSatang: r.amountSatang.toString(), whtSatang: withheld.toString(), transferSatang: (r.amountSatang - withheld).toString() } })
  }
  return { ok: true, events, whtSatang: tax.whtSatang, certificateId }
}
