import { bankOf } from '@/core/bankfile/banks'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate } from '@/core/thai'
import type { TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from './create'
import { registerSupplierTemplate, supplierMail, type SupplierNoticeFailed } from './supplier-notices'

// The e-mails of S9 to a supplier (ADR-126, ADR-135): registered here, in lane 2's own file, and imported by every module
// that writes or sends them (the bank account service, the job supplier-notice-send). Thai and English in one e-mail;
// the account appears as its bank and its last four digits only (BR-SUP-06, BR-BANK-08, NFR-SEC-09).

/** The template keys of S9 */
export const PAY_SUPPLIER_TEMPLATES = { bankAccountNotice: 'bank_account.notice', paymentAdvice: 'payment.advice' } as const

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const bankName = (code: unknown) => bankOf(str(code))?.nameTh ?? str(code)
const money = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? formatSatang(BigInt(v)) : '')
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])

// BR-SUP-06: the supplier hears at the address in the register that the account it is paid into is now this one, and
// whom to call if it did not ask for it
registerSupplierTemplate(PAY_SUPPLIER_TEMPLATES.bankAccountNotice, (d, c) =>
  supplierMail(
    `${c.organizationName} บันทึกบัญชีรับเงินของท่านแล้ว / Your bank account for payments was recorded`,
    [
      `เรียน ${c.supplierName}`,
      `${c.organizationName} บันทึกบัญชีรับเงินของท่านเป็น ${bankName(d.bankCode)} เลขที่ลงท้าย ${str(d.last4)} ตามคำขอเลขที่ ${str(d.number)} การจ่ายเงินครั้งถัดไปจะโอนเข้าบัญชีนี้`,
      `หากท่านไม่ได้ขอเปลี่ยนบัญชีนี้ โปรดติดต่อฝ่ายการเงินของ ${c.organizationName} ทันทีทางเบอร์โทรศัพท์ที่ท่านรู้จัก อย่าใช้ช่องทางติดต่อในอีเมลที่ไม่แน่ใจ`,
    ],
    [
      `${c.organizationName} has recorded your account at ${bankOf(str(d.bankCode))?.shortName ?? str(d.bankCode)} ending ${str(d.last4)} (request ${str(d.number)}). Your next payment goes to this account.`,
      `If you did not ask for this change, call the finance team of ${c.organizationName} at once on a number you already know; do not use contact details from an e-mail you are unsure of.`,
    ],
  ),
)

/**
 * §10.1 supplier_notice.failed of payment.advice: the preparer of the item's run (FINANCE, and so told already by
 * supplier.no_email when the supplier has no address: that case adds nothing here)
 */
const adviceFailed: SupplierNoticeFailed = async (tx: TenantTx, notice, reason): Promise<NotificationDraft[]> => {
  if (reason === 'NO_EMAIL') return []
  const item = await tx.paymentRunItem.findFirst({ where: { id: notice.subjectId }, select: { supplier: { select: { code: true } }, run: { select: { id: true, number: true, preparedById: true } } } })
  if (!item) return []
  return [
    {
      recipientMemberId: item.run.preparedById,
      templateKey: 'payment_run.advice_failed',
      data: { paymentRunId: item.run.id, number: item.run.number, supplierCode: item.supplier.code, reason },
      urgency: 'IMMEDIATE',
      dedupeKey: `payment_run.advice_failed:${notice.id}`,
      subjectType: 'PAYMENT_RUN',
      subjectId: item.run.id,
    },
  ]
}

interface AdviceWht {
  readonly incomeType: string
  readonly incomeName: string
  readonly rateBp: number
  readonly baseSatang: string
  readonly whtSatang: string
}
const whtOf = (v: unknown): AdviceWht[] => (Array.isArray(v) ? (v as AdviceWht[]) : [])
const rate = (bp: number) => `${bp / 100}%`

// BR-PAY-13 (OQ-134): one advice per paid item at the address in the register — the run's number, the day paid, the
// amount transferred, the invoices paid, the tax withheld by type and the 50 ทวิ attached when anything was withheld;
// the account as its bank and last four digits only. Its failure tells the run's preparer (payments/results.ts).
registerSupplierTemplate(PAY_SUPPLIER_TEMPLATES.paymentAdvice, (d, c) => {
  const paidOn = str(d.paidOn)
  const thaiDay = /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? formatThaiDate(new Date(`${paidOn}T00:00:00Z`)) : paidOn
  const invoices = list(d.invoices)
  const retentions = list(d.retentions)
  const wht = whtOf(d.wht).filter((w) => w.whtSatang !== '0')
  const certificate = str(d.certificateNumber)
  const mail = supplierMail(
    `${c.organizationName} ชำระเงินแล้ว รอบ ${str(d.number)} / Payment advice`,
    [
      `เรียน ${c.supplierName}`,
      `${c.organizationName} โอนเงิน ${money(d.transferSatang)} บาท เข้าบัญชี ${bankName(d.bankCode)} เลขที่ลงท้าย ${str(d.last4)} เมื่อวันที่ ${thaiDay} (รอบจ่าย ${str(d.number)})`,
      ...(invoices.length ? [`ใบแจ้งหนี้ที่ชำระ: ${invoices.join(', ')}`] : []),
      ...(retentions.length ? [`เงินประกันผลงานที่คืนของใบแจ้งหนี้: ${retentions.join(', ')}`] : []),
      `ยอดก่อนหักภาษี ${money(d.payableSatang)} บาท ภาษีหัก ณ ที่จ่าย ${money(d.whtSatang)} บาท`,
      ...wht.map((w) => `ภาษีหัก ณ ที่จ่าย ${w.incomeName || w.incomeType} ${rate(w.rateBp)} จากฐาน ${money(w.baseSatang)} บาท เป็นเงิน ${money(w.whtSatang)} บาท`),
      ...(certificate ? [`หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) เลขที่ ${certificate} แนบมากับอีเมลนี้`] : []),
      `หากยอดไม่ตรงกับที่ท่านได้รับ โปรดติดต่อฝ่ายการเงินของ ${c.organizationName}`,
    ],
    [
      `${c.organizationName} transferred THB ${money(d.transferSatang)} to your account at ${bankOf(str(d.bankCode))?.shortName ?? str(d.bankCode)} ending ${str(d.last4)} on ${paidOn} (payment run ${str(d.number)}).`,
      ...(invoices.length ? [`Invoices paid: ${invoices.join(', ')}`] : []),
      ...(retentions.length ? [`Retentions returned, of invoices: ${retentions.join(', ')}`] : []),
      `Amount before withholding THB ${money(d.payableSatang)}, withholding tax THB ${money(d.whtSatang)}.`,
      ...wht.map((w) => `Withholding tax ${w.incomeType} at ${rate(w.rateBp)} of THB ${money(w.baseSatang)}: THB ${money(w.whtSatang)}`),
      ...(certificate ? [`The withholding tax certificate (50 Tawi) no. ${certificate} is attached.`] : []),
      `If the amount does not match what you received, please contact the finance team of ${c.organizationName}.`,
    ],
  )
  const file = str(d.certificateFileId)
  return file ? { ...mail, attachFileIds: [file] } : mail
}, { onFailed: adviceFailed })
