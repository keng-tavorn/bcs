import { formatEnglishBeDateTime, formatThaiDateTime } from '@/core/thai/date'
import type { AppError } from '@/core/result'
import { makeCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { answerPostback, type LineAnswer } from '@/server/line/postback-approve'
import { cardContextOf, documentLink, type CardContext } from '@/server/line/postback-cards'
import { liffLink, registerLinePostbackHandler, type LineEventOutcome, type LinePostbackContext, type LinePostbackRequest } from '@/server/line/webhook'
import { decideRiskReview } from './reviews'

// The "ผ่าน" button of a reviewer's card of a supplier risk assessment (S11-06 · FR-RSK-202 AC4 · BR-RSK-08 ·
// BR-NOTI-12 · the card: src/channels/line/flex/risk-review-card.ts), plugged into the webhook's dispatcher as the
// approve button is (src/server/services/approvals/line-postback.ts); src/server/jobs/line-webhook.ts imports this module,
// so the webhook route and the line-webhook job both know the action. For one tap:
//  1. the data must be exactly v=1&a=risk_pass&t=<reviewTaskId>; anything else is skipped;
//  2. the actor is the member linked to the LINE user of the signed webhook (the dispatcher found them · BR-LINE-03);
//     a LINE user linked to nobody decides nothing and is told the button is not theirs, with the page that links LINE;
//  3. riskReview.decide passes the task on channel LINE_CHAT — the command the workspace and LIFF use — with LINE's
//     webhookEventId as its idempotency key: the same event run again (the line-webhook job) replays the stored answer,
//     while a second tap is a new event and finds the task decided (INVALID_STATE_TRANSITION, with who and when);
//  4. the answer — passed, or why not with where to go on — goes by the reply token while it is fresh, otherwise by a
//     push to the member (answerPostback · BR-LINE-07). A busy database throws, and the job tries the event again.
//
// Why no ActionToken (BR-TOK-02 gives an approval card's postback `k=<tokenId>`): ActionToken.taskId is a foreign key to
// ApprovalTask, so a ReviewTask cannot have one, and the data names the task instead. A task id is no secret and grants
// nothing by itself; what makes the tap safe is the chain an approval button has, without the token:
//  - the webhook's signature (x-line-signature · BR-LINE-03) proves LINE sent the event, so source.userId is the person
//    who tapped, never what a browser claims (BR-LINE-01);
//  - that LINE user must be linked to an ACTIVE member of this organization under the channel's provider (the
//    dispatcher resolves it: nobody linked → nothing is decided);
//  - the command decides only for the holder of the slot or whoever acts for them now (risk.review.decide with the
//    task's deciders · INV-RSK-04), refuses who opened or filled in the assessment (BR-SOD-16), and only while the task
//    is OPEN in the round under review. Anyone else's tap is FORBIDDEN or NOT_FOUND and learns nothing of the task.
// A reviewer needs no PIN (BR-WF-09, as S6's reviewers): passing moves no money and no authority.
// The chat's answers are written here, in Thai and English (services may not import src/channels, where the card's own
// words live). Logs name the organization, the event and codes only: never the LINE user id or the reply token.

/** The postback action of the card's pass button (RISK_PASS_ACTION of the card) */
export const RISK_PASS_POSTBACK_ACTION = 'risk_pass'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Codes another try may fix (§4.3 step 6): the event goes to the line-webhook job */
const TRANSIENT: ReadonlySet<string> = new Set(['RATE_LIMITED', 'INTERNAL'])

/**
 * The review task of `v=1&a=risk_pass&t=<uuid>` and nothing more (the dispatcher read v and a, and refused a key given
 * twice), lower case; null for anything else
 */
export function riskPassTaskOf(params: ReadonlyMap<string, string>): string | null {
  const t = params.get('t')
  return params.size === 3 && params.get('v') === '1' && params.get('a') === RISK_PASS_POSTBACK_ACTION && t !== undefined && UUID.test(t) ? t.toLowerCase() : null
}

// ---------- the answers in the chat ----------

type Locale = 'th' | 'en'

/** What a tap of "ผ่าน" did: passed, or why it decided nothing (the codes of riskReview.decide) */
export type RiskPassAnswer =
  /** IN_REVIEW: other slots still wait · COMPLETED: every slot passed */
  | { readonly kind: 'PASSED'; readonly number: string | null; readonly at: Date | null; readonly assessment: 'IN_REVIEW' | 'COMPLETED' | 'RETURNED' }
  /** INVALID_STATE_TRANSITION: decided already (who and when, when the task says) or closed (cancelled, round over) */
  | { readonly kind: 'DONE'; readonly name: string | null; readonly time: Date | null }
  /** BR-SOD-16: who opened or filled in the assessment never reviews it */
  | { readonly kind: 'SOD_VIOLATION' }
  /** FORBIDDEN · NOT_FOUND · a LINE user linked to nobody: not this person's task (nothing about it is said) */
  | { readonly kind: 'NOT_YOURS' }
  /** Any other refusal: open the page to see why */
  | { readonly kind: 'NOT_DECIDED' }

type Text = { readonly th: string; readonly en: string }
const WORDS = {
  passed: { th: 'ผ่านแล้ว: แบบประเมินความเสี่ยง', en: 'Passed: risk assessment' },
  at: { th: 'เมื่อ', en: 'On' },
  waitOthers: { th: 'รอผู้ตรวจส่วนอื่น', en: 'Waiting for the other reviewers' },
  allPassed: { th: 'ตรวจครบทุกส่วนแล้ว', en: 'Every part has been reviewed' },
  closed: { th: 'งานตรวจนี้ปิดแล้ว ไม่ต้องตรวจต่อ', en: 'This review is closed: there is nothing more to do.' },
  sod: { th: 'คุณตรวจแบบประเมินนี้ไม่ได้ เพราะคุณเป็นผู้เปิดหรือกรอกแบบประเมินนี้ (หลักการแบ่งแยกหน้าที่)', en: 'You cannot review this assessment: you opened or filled it in (separation of duties).' },
  notYours: {
    th: 'ปุ่มนี้ใช้ได้เฉพาะผู้ตรวจที่ได้รับงานนี้หรือผู้รักษาการแทน จากบัญชี LINE ที่ผูกไว้',
    en: 'Only the reviewer who received this task, or who acts for them, can use this button, from the LINE account linked to them.',
  },
  notDecided: { th: 'ตรวจรายการนี้ในแชทไม่ได้ โปรดเปิดรายการเพื่อดูรายละเอียด', en: 'This cannot be decided in the chat. Open it to see why.' },
} as const satisfies Record<string, Text>

/** "6 ต.ค. 2569 17:30 น." / "6 Oct 2569 17:30" in Thai time (FR-PLT-002 AC3), as the cards say times */
const timeOf = (at: Date, locale: Locale) => (locale === 'th' ? formatThaiDateTime(at) : formatEnglishBeDateTime(at))

function answerText(answer: RiskPassAnswer, locale: Locale): string {
  switch (answer.kind) {
    case 'PASSED': {
      const lines = [`${WORDS.passed[locale]} ${answer.number ?? '-'}`]
      if (answer.at) lines.push(`${WORDS.at[locale]} ${timeOf(answer.at, locale)}`)
      if (answer.assessment === 'IN_REVIEW') lines.push(WORDS.waitOthers[locale])
      else if (answer.assessment === 'COMPLETED') lines.push(WORDS.allPassed[locale])
      return lines.join('\n')
    }
    case 'DONE': {
      if (answer.name === null || answer.time === null) return WORDS.closed[locale]
      const time = timeOf(answer.time, locale)
      return locale === 'th' ? `งานตรวจนี้ดำเนินการแล้วโดย ${answer.name} เมื่อ ${time}` : `This review was already done by ${answer.name} on ${time}.`
    }
    case 'SOD_VIOLATION':
      return WORDS.sod[locale]
    case 'NOT_YOURS':
      return WORDS.notYours[locale]
    default:
      return WORDS.notDecided[locale]
  }
}

/** The answer in the chat (a LINE text message): what happened, then where to go on when there is somewhere (BR-NOTI-02) */
export function riskPassAnswerMessage(answer: RiskPassAnswer, locale: Locale, url: string | null): { readonly type: 'text'; readonly text: string } {
  return { type: 'text', text: [answerText(answer, locale), ...(url ? [url] : [])].join('\n') }
}

/** What a refusal of riskReview.decide says in the chat (the codes of ./reviews.ts) */
export function riskPassRefusalOf(error: AppError, locale: Locale): RiskPassAnswer {
  switch (error.code) {
    case 'INVALID_STATE_TRANSITION': {
      const details = error.details ?? {}
      const name = locale === 'en' && typeof details.nameEn === 'string' ? details.nameEn : typeof details.name === 'string' ? details.name : null
      const time = typeof details.time === 'string' && !Number.isNaN(Date.parse(details.time)) ? new Date(details.time) : null
      return { kind: 'DONE', name, time }
    }
    case 'SOD_VIOLATION':
      return { kind: 'SOD_VIOLATION' }
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'UNAUTHENTICATED':
      return { kind: 'NOT_YOURS' }
    default:
      return { kind: 'NOT_DECIDED' }
  }
}

// ---------- the handler ----------

/** The page of the task: /liff/risk/reviews/<id> with a LIFF app, else the workspace's /risk/reviews/<id> */
const reviewLink = (cards: CardContext, taskId: string) => documentLink(cards, `/risk/reviews/${taskId}`)

function outcomeOf(refused: string | null, answered: LineAnswer): LineEventOutcome {
  const notes = [...(refused ? [refused] : []), ...(answered === 'REPLIED' ? [] : [answered])]
  return notes.length > 0 ? { status: 'PROCESSED', reason: notes.join(',') } : { status: 'PROCESSED' }
}

export async function riskPassPostbackHandler(request: LinePostbackRequest, context: LinePostbackContext): Promise<LineEventOutcome> {
  const taskId = riskPassTaskOf(request.params)
  if (!taskId) return { status: 'SKIPPED', reason: 'POSTBACK_INVALID' }
  const cards = await cardContextOf(request.organizationId, context.channel.liffId)

  // Linked to nobody: nothing is decided, and the answer names nothing of the task — only where LINE is linked
  if (request.memberId === null) {
    const message = riskPassAnswerMessage({ kind: 'NOT_YOURS' }, cards.locale, cards.liffId ? liffLink(cards.liffId, '/link') : null)
    return outcomeOf('NOT_LINKED', await answerPostback(context.channel, request, [message], context))
  }

  const ctx = makeCtx({
    organizationId: request.organizationId,
    actor: { type: 'USER', memberId: request.memberId },
    channel: 'LINE_CHAT',
    now: context.clock.now(),
    requestId: request.eventId,
  })
  const result = await decideRiskReview(ctx, { taskId, decision: 'PASS' }, { idempotencyKey: `line-postback:${request.webhookEventId}` })
  if (!result.ok && TRANSIENT.has(result.error.code)) throw new Error(`passing a risk review from a LINE button did not finish (${result.error.code}); the line-webhook job tries the event again`)

  let message
  if (result.ok) {
    // Only the member who passed it reads this: the number and when, from the task as it is now
    const task = await forTenant(request.organizationId).reviewTask.findFirst({ where: { id: result.data.taskId }, select: { decidedAt: true, assessment: { select: { number: true } } } })
    message = riskPassAnswerMessage({ kind: 'PASSED', number: task?.assessment.number ?? null, at: task?.decidedAt ?? null, assessment: result.data.assessment }, cards.locale, reviewLink(cards, taskId))
  } else {
    const answer = riskPassRefusalOf(result.error, cards.locale)
    // Not theirs: their own list of reviews, never the task's page; otherwise the task's page says the rest
    const url = answer.kind === 'NOT_YOURS' ? documentLink(cards, '/risk/reviews') : reviewLink(cards, taskId)
    message = riskPassAnswerMessage(answer, cards.locale, url)
  }
  return outcomeOf(result.ok ? null : result.error.code, await answerPostback(context.channel, request, [message], context))
}

registerLinePostbackHandler(RISK_PASS_POSTBACK_ACTION, riskPassPostbackHandler)
