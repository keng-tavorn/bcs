import { bankOf } from '@/core/bankfile/banks'
import { registerSupplierTemplate, supplierMail } from './supplier-notices'

// The e-mails of S9 to a supplier (ADR-126, ADR-135): registered here, in lane 2's own file, and imported by every module
// that writes or sends them (the bank account service, the job supplier-notice-send). Thai and English in one e-mail;
// the account appears as its bank and its last four digits only (BR-SUP-06, BR-BANK-08, NFR-SEC-09).

/** The template keys of S9 */
export const PAY_SUPPLIER_TEMPLATES = { bankAccountNotice: 'bank_account.notice' } as const

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
const bankName = (code: unknown) => bankOf(str(code))?.nameTh ?? str(code)

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
