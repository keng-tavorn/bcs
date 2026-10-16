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
  // S6 · BR-WF-09: a reviewer's card — pass in the chat, return with its reason in LIFF; a reviewer never rejects
  reviewHeader: { th: 'โปรดตรวจก่อนอนุมัติ', en: 'Waiting for your review' },
  reviewRules: { th: 'ตรวจตามข้อ', en: 'Review rule' },
  pass: { th: 'ผ่าน', en: 'Pass' },
  returnOnly: { th: 'ตีกลับ', en: 'Return' },
  // S6-11 · BR-PRC-05: the one price badge of a request, with counts and percents only
  price: { th: 'ราคา', en: 'Price' },
  // S6-13 · BR-DUP-05: a flag of the request in a few words, never what it buys (BR-NOTI-01)
  flagDuplicate: { th: 'คล้ายคำขอที่ส่งไปแล้ว', en: 'Looks like a request sent before' },
  flagSplit: { th: 'อาจแตกยอดเลี่ยงวงเงิน', en: 'May split a purchase under a limit' },
} as const satisfies Record<string, Text>

const CONFIRMATION = {
  header: { th: 'อนุมัติแล้ว', en: 'Approved' },
  under: { th: 'อนุมัติภายใต้', en: 'Approved under' },
  at: { th: 'เมื่อ', en: 'On' },
  nextStep: { th: 'ส่งต่อผู้อนุมัติขั้นถัดไปแล้ว', en: 'It has gone on to the next approver' },
  done: { th: 'อนุมัติครบทุกขั้นแล้ว', en: 'Every approval step is done' },
  // S6: a reviewer's pass (BR-WF-09) is no approval
  reviewHeader: { th: 'ผ่านแล้ว', en: 'Passed' },
  reviewUnder: { th: 'ตรวจในเส้นทางของ', en: 'Reviewed on the route of' },
  reviewNext: { th: 'รอผู้ตรวจคนอื่นหรือส่งต่อผู้อนุมัติแล้ว', en: 'Waiting for the other reviewers, or gone on to the approver' },
} as const satisfies Record<string, Text>

export type CardLabel = keyof typeof CARD
export type ConfirmationLabel = keyof typeof CONFIRMATION

export const cardLabel = (key: CardLabel, locale: CardLocale): string => CARD[key][locale]
export const confirmationLabel = (key: ConfirmationLabel, locale: CardLocale): string => CONFIRMATION[key][locale]

/**
 * BR-PRC-05: "ราคาสูงกว่าค่ากลางย้อนหลัง 1 รายการ สูงสุด +8%" and its LOW side; never an item, a unit price or an AI
 * summary (BR-NOTI-01 · OQ-107)
 */
export function priceBadgeText(badge: { readonly high: { readonly lines: number; readonly maxPct: number } | null; readonly low: { readonly lines: number; readonly minPct: number } | null }, locale: CardLocale): string {
  const parts: string[] = []
  if (badge.high) parts.push(locale === 'th' ? `สูงกว่าค่ากลางย้อนหลัง ${badge.high.lines} รายการ สูงสุด +${badge.high.maxPct}%` : `Above the past median: ${badge.high.lines} line(s), up to +${badge.high.maxPct}%`)
  if (badge.low) parts.push(locale === 'th' ? `ต่ำกว่าค่ากลางย้อนหลัง ${badge.low.lines} รายการ ต่ำสุด ${badge.low.minPct}%` : `Below the past median: ${badge.low.lines} line(s), down to ${badge.low.minPct}%`)
  return parts.join(' · ')
}

/** "DOA-DEMO ฉบับ 1 ข้อ PR-02" / "DOA-DEMO version 1 rule PR-02" (§9.3, FR-DOA-005 AC2) */
export function doaReference(doa: { readonly code: string; readonly versionNo: number; readonly ruleCode: string }, locale: CardLocale): string {
  return locale === 'th' ? `${doa.code} ฉบับ ${doa.versionNo} ข้อ ${doa.ruleCode}` : `${doa.code} version ${doa.versionNo} rule ${doa.ruleCode}`
}
