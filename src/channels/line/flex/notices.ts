import { clip, clipLines, dateTimeOf, NOTICE_BODY_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH, CARD_NAME_MAX_LENGTH } from './text'
import type { CardLocale, TextMessage } from './types'

// Short text messages (spec §4.7 rule 2, BR-NOTI-01 to 03): a notification other than an approval task goes to LINE as
// its title, its body and a link back to the document (a LIFF page, or the workspace); and the answers to a button that
// could not decide (§9.3, FR-LINE-002 AC3), each with what happened and where to go on. The words follow the error
// templates of §14.2 ("รายการนี้ดำเนินการแล้วโดย {name} เมื่อ {time}") said for a button in a chat.

export interface TextNoticeData {
  readonly title: string
  readonly body: string | null
  /** BR-NOTI-02: every message links back to the document */
  readonly url: string
}

export function textNotice(data: TextNoticeData): TextMessage {
  const body = data.body ? clipLines(data.body, NOTICE_BODY_MAX_LENGTH) : ''
  return { type: 'text', text: [clip(data.title, NOTICE_TITLE_MAX_LENGTH), ...(body ? [body] : []), data.url].join('\n') }
}

/** Why a tap of the approve button decided nothing, with what the answer may say */
export type PostbackRefusal =
  /** Decided already (this button, another channel, or whoever acts for the approver): who and when, from the task */
  | { readonly kind: 'TOKEN_USED'; readonly name: string | null; readonly time: Date | null }
  | { readonly kind: 'TOKEN_EXPIRED' | 'TOKEN_INVALID' | 'FORBIDDEN' | 'STEP_UP_REQUIRED' | 'SOD_VIOLATION' | 'NOT_OPEN' | 'NOT_DECIDED' }

type Text = { readonly th: string; readonly en: string }

const REFUSAL: Readonly<Record<Exclude<PostbackRefusal['kind'], 'TOKEN_USED'>, Text>> = {
  TOKEN_EXPIRED: { th: 'ปุ่มนี้หมดอายุแล้ว โปรดเปิดรายการเพื่อพิจารณา', en: 'This button has expired. Open the item to decide on it.' },
  TOKEN_INVALID: { th: 'ปุ่มนี้ใช้ไม่ได้แล้ว งานนี้อาจย้ายไปผู้อื่นหรือถูกยกเลิก', en: 'This button no longer works: the task may have moved to someone else or been cancelled.' },
  FORBIDDEN: { th: 'ปุ่มนี้ใช้ได้เฉพาะผู้ที่ได้รับงาน จากบัญชี LINE ที่ผูกไว้', en: 'Only the person who received this task can use this button, from the LINE account linked to them.' },
  STEP_UP_REQUIRED: { th: 'รายการนี้ต้องยืนยันด้วย PIN โปรดเปิดรายการเพื่อยืนยัน', en: 'This one needs your PIN. Open it to confirm.' },
  SOD_VIOLATION: { th: 'ทำรายการนี้ไม่ได้เพราะขัดหลักการแบ่งแยกหน้าที่', en: 'You cannot decide this: it would break the separation of duties.' },
  NOT_OPEN: { th: 'รายการนี้ไม่อยู่ในสถานะที่อนุมัติได้แล้ว', en: 'This item can no longer be approved.' },
  NOT_DECIDED: { th: 'ตัดสินรายการนี้ในแชทไม่ได้ โปรดเปิดรายการเพื่อดูรายละเอียด', en: 'This cannot be decided in the chat. Open the item to see why.' },
}

function refusalText(refusal: PostbackRefusal, locale: CardLocale): string {
  if (refusal.kind !== 'TOKEN_USED') return REFUSAL[refusal.kind][locale]
  if (refusal.name === null || refusal.time === null) return locale === 'th' ? 'รายการนี้ดำเนินการแล้ว' : 'This has already been done.'
  const name = clip(refusal.name, CARD_NAME_MAX_LENGTH)
  const time = dateTimeOf(refusal.time, locale)
  return locale === 'th' ? `รายการนี้ดำเนินการแล้วโดย ${name} เมื่อ ${time}` : `This was already done by ${name} on ${time}.`
}

/** The answer to a refused tap: the reason, then where to go on (the item, or the page that helps) when there is one */
export function postbackRefusalMessage(refusal: PostbackRefusal, locale: CardLocale, url: string | null): TextMessage {
  return { type: 'text', text: [refusalText(refusal, locale), ...(url ? [url] : [])].join('\n') }
}
