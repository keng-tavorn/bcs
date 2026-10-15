import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/db/client'
import { confirmIncomeType, updateIncomeType, updateSupplierTaxProfile } from '@/server/services/ap/wht'
import { addPaymentDocuments, createPaymentRun, setPaymentFlagReason, submitPaymentRun } from '@/server/services/payments/runs'
import { AP_NOW, apOrg, codedDraft, fin, key, ok, receive, submit, type ApOrg } from './ap'

// Payment run tests (S9-05 onwards): an organization of the phase-1 fixtures with PAY on (./ap.ts), SERVICE withheld at
// 3% (confirmed by a second FINANCE member), and a payer account of the organization as the seed of a sample one makes
// it (CB-01, the neutral template). Suppliers of their own per test, each with an ACTIVE account from the seed unless
// asked otherwise; invoices made ready for payment through S8's services, then given the due date the test needs.
// AP_NOW is Monday 12 Oct 2026; the fixture's holidays are 13 and 23 Oct; the run weekday is Friday (OQ-130).

export const PAY_DATE = '2026-10-16'
const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')

export interface PayOrg extends ApOrg {
  readonly payerId: string
}

export async function payOrg(): Promise<PayOrg> {
  const ap = await apOrg()
  ok(await updateIncomeType(fin(ap), { code: 'SERVICE', nameTh: 'ค่าบริการ', rateBp: 300, form: 'PND3_53', active: true }, key()))
  ok(await confirmIncomeType(fin(ap, 'dm_fin'), { code: 'SERVICE' }, key()))
  const payerId = (
    await prisma.bankAccount.create({
      data: { organizationId: ap.org.organizationId, ownerKind: 'ORGANIZATION', code: 'CB-01', bankCode: '004', accountNo: '1000000016', accountName: 'องค์กรทดสอบ DOA', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', activatedAt: AP_NOW },
    })
  ).id
  return { ...ap, payerId }
}

/** A supplier of the test with an ACTIVE account from the seed (or none), withholding SERVICE on service POs */
export async function paySupplier(ap: ApOrg, options: { account?: boolean } = {}) {
  const n = randomUUID().slice(0, 6)
  const s = await prisma.supplier.create({ data: { organizationId: ap.org.organizationId, code: `SP-${n}`, nameTh: `ผู้ขาย ${n}`, taxId: `01${digits(11)}`, email: `pay-${n}@supplier.test.bcs.local` } })
  ok(await updateSupplierTaxProfile(fin(ap), { supplierId: s.id, payeeType: 'JURISTIC', defaultWhtIncomeTypeCode: 'SERVICE' }, key()))
  let accountNo: string | null = null
  if (options.account !== false) {
    accountNo = `2${digits(9)}`
    await prisma.bankAccount.create({ data: { organizationId: ap.org.organizationId, ownerKind: 'SUPPLIER', supplierId: s.id, bankCode: '014', accountNo, accountName: `ผู้ขาย ${n}`, activatedAt: new Date('2026-01-01T00:00:00Z') } })
  }
  return { id: s.id, code: s.code, email: s.email!, accountNo }
}

let dates = 0
/** An invoice of the supplier ready for payment, due on `due`: a PO sent and received, the invoice matched (S8) */
export async function readyInvoice(ap: ApOrg, supplierId: string, unitPrice: string, vat: string, due: string, service = false) {
  const budgetLineId = await ap.flow.fundedLine(10_000_000n)
  await prisma.budgetLine.update({ where: { id: budgetLineId }, data: { accountCode: '510101' } })
  const pr = await ap.flow.approvedRequest(budgetLineId, [{ quantity: '1', unitPrice }])
  const po = await ap.flow.approvedPo(
    pr.lines.map((l) => l.id),
    supplierId,
  )
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT', sentAt: AP_NOW, ...(service ? { kind: 'SERVICE' } : {}) } })
  const sentPo = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } })
  await receive(ap, sentPo, { 0: '1' })
  const date = new Date(Date.UTC(2026, 8, 30 - (++dates % 28))).toISOString().slice(0, 10)
  const draft = await codedDraft(ap, sentPo, { no: `P-${randomUUID().slice(0, 8)}`, date, vat, lines: [{ line: 0, quantity: '1', unitPrice }] })
  const status = ok(await submit(ap, draft)).status
  if (status !== 'READY_FOR_PAYMENT') throw new Error(`the invoice is ${status}, not ready for payment`)
  await prisma.invoice.update({ where: { id: draft.invoiceId }, data: { dueDate: new Date(`${due}T00:00:00Z`) } })
  return draft.invoiceId
}

/** A released retention of the supplier (as S8-09 leaves one), on an invoice of its own */
export async function releasableRetention(ap: ApOrg, supplierId: string, amount: bigint) {
  const invoiceId = await readyInvoice(ap, supplierId, '100.00', '7.00', '2026-12-31', true)
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })
  // its invoice was paid before; the retention held back on it is released now
  await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'PAID' } })
  return (await prisma.retention.create({ data: { organizationId: ap.org.organizationId, invoiceId, poId: invoice.poId, supplierId, amountSatang: amount, status: 'RELEASABLE', releaseDueOn: new Date('2026-10-01T00:00:00Z') } })).id
}

export const runVersion = async (id: string) => (await prisma.paymentRun.findUniqueOrThrow({ where: { id } })).version

export async function draftRun(ap: PayOrg, by = 'fin_officer', payDate = PAY_DATE) {
  return ok(await createPaymentRun(fin(ap, by), { payerBankAccountId: ap.payerId, payDate }, key())).paymentRunId
}

export async function addDocs(ap: ApOrg, runId: string, docs: { invoiceIds?: string[]; retentionIds?: string[] }, by = 'fin_officer') {
  return addPaymentDocuments(fin(ap, by), { paymentRunId: runId, version: await runVersion(runId), ...docs }, key())
}

/** A run of these invoices sent for approval by fin_officer; flags explained first when asked */
export async function sentRun(ap: PayOrg, invoiceIds: string[], reasons: Record<string, string> = {}, payDate = PAY_DATE) {
  const run = await draftRun(ap, 'fin_officer', payDate)
  ok(await addDocs(ap, run, { invoiceIds }))
  for (const [supplierId, reason] of Object.entries(reasons)) ok(await setPaymentFlagReason(fin(ap), { paymentRunId: run, version: await runVersion(run), supplierId, reason }, key()))
  return { runId: run, ...ok(await submitPaymentRun(fin(ap), { paymentRunId: run, version: await runVersion(run) }, key())) }
}

/**
 * A payment item of the supplier in a draft run of its own, from a payer account of the organization: S8's tests pay
 * through it as S9 does (recordInvoicePayment writes the item's id on the tax rows and the 50 ทวิ, S9-08)
 */
export async function paymentItemOf(ap: ApOrg, supplierId: string): Promise<string> {
  const organizationId = ap.org.organizationId
  const payer =
    (await prisma.bankAccount.findFirst({ where: { organizationId, ownerKind: 'ORGANIZATION', code: 'CB-T' } })) ??
    (await prisma.bankAccount.create({ data: { organizationId, ownerKind: 'ORGANIZATION', code: 'CB-T', bankCode: '004', accountNo: '1000000024', accountName: 'องค์กรทดสอบ', accountType: 'CURRENT', fileTemplateCode: 'BCS-NEUTRAL-1', activatedAt: AP_NOW } }))
  const run = await prisma.paymentRun.create({ data: { organizationId, payDate: new Date(`${PAY_DATE}T00:00:00Z`), payerBankAccountId: payer.id, fileTemplateCode: 'BCS-NEUTRAL-1', preparedById: ap.org.member.fin_officer! } })
  return (await prisma.paymentRunItem.create({ data: { organizationId, paymentRunId: run.id, supplierId } })).id
}
