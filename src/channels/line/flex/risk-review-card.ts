import { heading, INK, PRIMARY, row, SURFACE, vertical, WARN } from './style'
import { ACTION_LABEL_MAX_LENGTH, CARD_LABEL_MAX_LENGTH, CARD_NAME_MAX_LENGTH, clip, dateTimeOf } from './text'
import type { CardLocale, FlexAction, FlexButton, FlexComponent, FlexMessage } from './types'

// The LINE card of a reviewer's task of a supplier risk assessment (S11-06 · FR-RSK-202 AC4 · BR-RSK-08 · BR-NOTI-12),
// sent at once to the holder of the slot with the notice risk.review_assigned.
// A summary only (BR-LINE-06, BR-NOTI-01): the assessment's number, the supplier's name only when the notice carries one
// (a sole proprietor is never named · BR-NOTI ข้อ 10), the tier, the parts the reviewer reads (GENERAL and the slot's
// domains · BR-RSK-08), how many questions and the due time — never an answer, a score, a file or a reason. Buttons:
//  - "ผ่าน": a postback `v=1&a=risk_pass&t=<reviewTaskId>` (src/server/services/risk/line-postback.ts decides it);
//  - "ตีกลับ": the LIFF page /liff/risk/reviews/<reviewTaskId>, where the reason is typed (a reviewer never rejects).
// The postback carries the task, not an ActionToken: ActionToken.taskId is a foreign key to ApprovalTask, so a
// reviewer's task cannot have one. What stands in for it is written where the postback is decided.
// The fixed words are kept here, in Thai and English, as labels.ts keeps the approval card's. Pure: the caller passes
// what to show; the card never reads the database or the clock.

type Text = { readonly th: string; readonly en: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The postback action of the pass button (a lower-case action name of the webhook's dispatcher) */
export const RISK_PASS_ACTION = 'risk_pass'

const CARD = {
  header: { th: 'แบบประเมินความเสี่ยงรอคุณตรวจ', en: 'A risk assessment waits for your review' },
  reassigned: { th: 'งานตรวจนี้ย้ายมาที่คุณ', en: 'This review moved to you' },
  altText: { th: 'แบบประเมินความเสี่ยงรอคุณตรวจ', en: 'A risk assessment waits for your review' },
  number: { th: 'เลขที่', en: 'Number' },
  supplier: { th: 'ผู้ขาย', en: 'Supplier' },
  tier: { th: 'ระดับความเสี่ยง', en: 'Risk tier' },
  parts: { th: 'ส่วนที่คุณตรวจ', en: 'Your part' },
  questions: { th: 'จำนวนข้อ', en: 'Questions' },
  due: { th: 'กำหนด', en: 'Due' },
  pass: { th: 'ผ่าน', en: 'Pass' },
  return: { th: 'ตีกลับ', en: 'Return' },
} as const satisfies Record<string, Text>

/** The words of src/server/notifications/templates/risk.ts, for a card */
const TIER: Readonly<Record<string, Text>> = { LOW: { th: 'ต่ำ', en: 'Low' }, MEDIUM: { th: 'กลาง', en: 'Medium' }, HIGH: { th: 'สูง', en: 'High' } }
const DOMAIN: Readonly<Record<string, Text>> = {
  GENERAL: { th: 'ทั่วไป', en: 'General' },
  PRIVACY: { th: 'ข้อมูลส่วนบุคคล', en: 'Privacy' },
  INFOSEC: { th: 'ความปลอดภัยสารสนเทศ', en: 'Information security' },
  PREMISES: { th: 'ความปลอดภัยสถานที่', en: 'Premises safety' },
  FINANCE: { th: 'การเงิน', en: 'Finance' },
}
/** The parts row: GENERAL and four domains fit in full; a value outside the known set is cut */
const PARTS_MAX_LENGTH = 160

const word = (text: Text, locale: CardLocale) => text[locale]

export interface RiskReviewCardData {
  readonly locale: CardLocale
  /** ReviewTask.id */
  readonly taskId: string
  /** The assessment's number (RSA-2569-00012); null shows "-" */
  readonly number: string | null
  /** The supplier's name; null for a sole proprietor (BR-NOTI ข้อ 10) or when the notice carries none */
  readonly supplierName: string | null
  /** LOW · MEDIUM · HIGH; null leaves the row out */
  readonly tier: string | null
  /** The slot's own domains; GENERAL is always read and shown first (BR-RSK-08) */
  readonly riskDomains: readonly string[]
  /** How many questions of the reviewer's parts the assessment asked; null leaves the row out */
  readonly questionCount: number | null
  readonly dueAt: Date | null
  /** The task moved to this reviewer after an org change (review_task.reassigned) */
  readonly reassigned: boolean
  readonly links: {
    /** /liff/risk/reviews/<taskId>, or the workspace's /risk/reviews/<taskId> without a LIFF app */
    readonly review: string
  }
}

/**
 * The postback data of the pass button: exactly v, a and t. src/server/services/risk/line-postback.ts reads it back
 * (riskPassTaskOf there: services may not import channels), and tests/unit/risk-review-line.test.ts holds the two together.
 */
export const riskPassPostbackData = (taskId: string) => `v=1&a=${RISK_PASS_ACTION}&t=${taskId}`

/** "ทั่วไป, ข้อมูลส่วนบุคคล" — GENERAL first, each domain once, in the order the slot lists them */
export function riskPartsText(riskDomains: readonly string[], locale: CardLocale): string {
  const parts = [...new Set(['GENERAL', ...riskDomains])].map((d) => {
    const domain = DOMAIN[d]
    return domain ? word(domain, locale) : d
  })
  return clip(parts.join(', '), PARTS_MAX_LENGTH)
}

const label = (text: string) => clip(text, ACTION_LABEL_MAX_LENGTH)

export function riskReviewCard(data: RiskReviewCardData): FlexMessage {
  const t = data.locale
  const number = clip(data.number ?? '-', CARD_LABEL_MAX_LENGTH)
  const rows: FlexComponent[] = [row(word(CARD.number, t), number)]
  if (data.supplierName) rows.push(row(word(CARD.supplier, t), clip(data.supplierName, CARD_NAME_MAX_LENGTH)))
  if (data.tier) {
    const tier = TIER[data.tier]
    rows.push(row(word(CARD.tier, t), tier ? word(tier, t) : clip(data.tier, CARD_NAME_MAX_LENGTH)))
  }
  rows.push(row(word(CARD.parts, t), riskPartsText(data.riskDomains, t)))
  if (data.questionCount !== null && Number.isInteger(data.questionCount) && data.questionCount >= 0) {
    rows.push(row(word(CARD.questions, t), t === 'th' ? `${data.questionCount} ข้อ` : String(data.questionCount)))
  }
  if (data.dueAt) rows.push(row(word(CARD.due, t), dateTimeOf(data.dueAt, t)))

  const pass = word(CARD.pass, t)
  // A task id that is not one (never from the database) gets no postback: the button opens the page instead
  const passAction: FlexAction = UUID.test(data.taskId)
    ? { type: 'postback', label: label(pass), data: riskPassPostbackData(data.taskId.toLowerCase()), displayText: `${pass} ${number}` }
    : { type: 'uri', label: label(pass), uri: data.links.review }
  const buttons: FlexButton[] = [
    { type: 'button', style: 'primary', color: PRIMARY, height: 'md', action: passAction },
    // A return needs its reason, typed on the LIFF page; outlined so it never looks like the pass (§9.9)
    { type: 'button', style: 'secondary', height: 'md', action: { type: 'uri', label: label(word(CARD.return, t)), uri: data.links.review } },
  ]
  const badges: FlexComponent[] = data.reassigned ? [{ type: 'text', text: word(CARD.reassigned, t), size: 'md', color: WARN, wrap: true }] : []

  return {
    type: 'flex',
    altText: `${word(CARD.altText, t)}: ${number}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: vertical([heading(word(CARD.header, t), INK), ...badges], { paddingAll: '16px', backgroundColor: SURFACE, spacing: 'sm' }),
      body: vertical(rows, { spacing: 'md', paddingAll: '16px' }),
      // Apart, with the space LINE's "md" gives, so a tap meant for one never lands on the other (§9.9)
      footer: vertical(buttons, { spacing: 'md', paddingAll: '16px' }),
    },
  }
}
