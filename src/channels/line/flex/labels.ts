import { PAY_SUBJECT_KINDS } from './labels-pay'
import type { CardLocale } from './types'

// The fixed words of the LINE cards and replies, in Thai and English (BR-NOTI-03: the reader's language, polite and
// short; §10.3 "โปรดพิจารณา"). Notification texts themselves come from src/server/notifications/templates; these are the
// labels around them. No label names a person: the only name a card shows is the requester's (BR-NOTI-01).

type Text = { readonly th: string; readonly en: string }

export const SUBJECT_KIND: Readonly<Record<string, Text>> = {
  REQUEST: { th: 'คำขอซื้อ', en: 'Purchase request' },
  PURCHASE_ORDER: { th: 'ใบสั่งซื้อ', en: 'Purchase order' },
  VARIANCE: { th: 'ผลต่างการตรวจรับ', en: 'Receiving variance' },
  DOA_VERSION: { th: 'DOA ฉบับใหม่', en: 'DOA version' },
  ORG_AUTHORITY_CHANGE: { th: 'การเปลี่ยนโครงสร้างอำนาจ', en: 'Authority change' },
  // S9 (ADR-135)
  ...PAY_SUBJECT_KINDS,
}
const DOCUMENT: Text = { th: 'เอกสาร', en: 'Document' }

export function subjectKind(subjectType: string, locale: CardLocale): string {
  return (SUBJECT_KIND[subjectType] ?? DOCUMENT)[locale]
}

const CARD = {
  header: { th: 'โปรดพิจารณาอนุมัติ', en: 'Waiting for your approval' },
  altText: { th: 'โปรดพิจารณา', en: 'Please review' },
  number: { th: 'เลขที่', en: 'Number' },
  type: { th: 'ประเภท', en: 'Type' },
  requester: { th: 'ผู้ขอ', en: 'Requested by' },
  amount: { th: 'ยอดตามฐาน DOA', en: 'Amount (DOA basis)' },
  basisNet: { th: 'ก่อน VAT', en: 'before VAT' },
  basisGross: { th: 'รวม VAT', en: 'incl. VAT' },
  budget: { th: 'งบ', en: 'Budget' },
  budgetReserved: { th: 'จองแล้ว', en: 'Reserved' },
  budgetEnough: { th: 'พอ', en: 'Enough' },
  due: { th: 'กำหนด', en: 'Due' },
  overdue: { th: 'เลยกำหนดแล้ว', en: 'past due' },
  doa: { th: 'DOA', en: 'DOA' },
  acting: { th: 'รักษาการแทน', en: 'Acting on behalf' },
  escalated: { th: 'ส่งต่อเพราะเลยกำหนด', en: 'Escalated: past due' },
  pinNeeded: { th: 'รายการนี้ต้องยืนยันด้วย PIN', en: 'This one needs your PIN' },
  approve: { th: 'อนุมัติ', en: 'Approve' },
  approveWithPin: { th: 'อนุมัติ (ยืนยัน PIN)', en: 'Approve (PIN)' },
  decline: { th: 'ตีกลับ / ไม่อนุมัติ', en: 'Return / Reject' },
  details: { th: 'ดูรายละเอียด', en: 'View details' },
} as const satisfies Record<string, Text>

const CONFIRMATION = {
  header: { th: 'อนุมัติแล้ว', en: 'Approved' },
  under: { th: 'อนุมัติภายใต้', en: 'Approved under' },
  at: { th: 'เมื่อ', en: 'On' },
  nextStep: { th: 'ส่งต่อผู้อนุมัติขั้นถัดไปแล้ว', en: 'It has gone on to the next approver' },
  done: { th: 'อนุมัติครบทุกขั้นแล้ว', en: 'Every approval step is done' },
} as const satisfies Record<string, Text>

export type CardLabel = keyof typeof CARD
export type ConfirmationLabel = keyof typeof CONFIRMATION

export const cardLabel = (key: CardLabel, locale: CardLocale): string => CARD[key][locale]
export const confirmationLabel = (key: ConfirmationLabel, locale: CardLocale): string => CONFIRMATION[key][locale]

/** "DOA-DEMO ฉบับ 1 ข้อ PR-02" / "DOA-DEMO version 1 rule PR-02" (§9.3, FR-DOA-005 AC2) */
export function doaReference(doa: { readonly code: string; readonly versionNo: number; readonly ruleCode: string }, locale: CardLocale): string {
  return locale === 'th' ? `${doa.code} ฉบับ ${doa.versionNo} ข้อ ${doa.ruleCode}` : `${doa.code} version ${doa.versionNo} rule ${doa.ruleCode}`
}
