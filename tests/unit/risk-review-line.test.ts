import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ACTION_LABEL_MAX_LENGTH, riskPassPostbackData, riskReviewCard, type FlexMessage, type RiskReviewCardData } from '@/channels/line/flex'
import { liffPathFor, liffRiskReviewPath } from '@/channels/line/links'
import {
  jsonByteLength,
  LINE_ALT_TEXT_MAX_LENGTH,
  LINE_FLEX_BUBBLE_MAX_BYTES,
  LINE_POSTBACK_DATA_MAX_LENGTH,
  LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH,
  lineMessageProblems,
} from '@/integrations/line'
import { liffRiskResultOf, type LiffRiskWords } from '@/app/liff/risk/reviews/[id]/result'

// S11-06 · the reviewer's LINE side of a supplier risk assessment (FR-RSK-202 AC4 · BR-RSK-08 · BR-NOTI-12): the card of
// risk.review_assigned shows a summary only and never an answer (BR-NOTI-01, BR-LINE-06), names the supplier only when
// the notice does (a sole proprietor never), fits LINE's limits with the longest name and every domain; its "ผ่าน" is the
// postback `v=1&a=risk_pass&t=<reviewTaskId>` and nothing else, read back by the webhook's handler, which decides as the
// LINE-linked member on channel LINE_CHAT with LINE's event id as the idempotency key; "ตีกลับ" opens the LIFF page.

// The handler's module is loaded with its server neighbours replaced: these tests read the data it accepts and what it
// hands the command and the chat, not the database (tests/integration covers riskReview.decide itself)
const mocks = vi.hoisted(() => ({
  registered: [] as unknown[][],
  answer: vi.fn(async () => 'REPLIED' as const),
  decide: vi.fn(),
  task: { decidedAt: new Date('2026-11-09T03:00:00Z'), assessment: { number: 'RSA-2569-00012' } } as unknown,
}))
vi.mock('@/server/line/webhook', () => ({ registerLinePostbackHandler: (...args: unknown[]) => void mocks.registered.push(args), liffLink: (liffId: string, path: string) => `https://liff.line.me/${liffId}${path}` }))
vi.mock('@/server/line/postback-approve', () => ({ answerPostback: mocks.answer }))
vi.mock('@/server/line/postback-cards', () => ({
  cardContextOf: async (_organizationId: string, liffId: string | null) => ({ locale: 'th', liffId, appUrl: 'https://bcs.example' }),
  documentLink: (cards: { liffId: string | null; appUrl: string }, href: string) => (cards.liffId && href.startsWith('/risk/reviews/') ? `https://liff.line.me/${cards.liffId}${href}` : `${cards.appUrl}${href}`),
}))
vi.mock('@/server/db/tenant', () => ({ forTenant: () => ({ reviewTask: { findFirst: async () => mocks.task } }) }))
vi.mock('@/server/services/risk/reviews', () => ({ decideRiskReview: mocks.decide }))
const { RISK_PASS_POSTBACK_ACTION, riskPassAnswerMessage, riskPassPostbackHandler, riskPassRefusalOf, riskPassTaskOf } = await import('@/server/services/risk/line-postback')

const TASK = '01928c6e-7f3a-7b2c-9d4e-00000000a001'
const LIFF_ID = '1650000003-AbCdEfGh'
const LIFF = `https://liff.line.me/${LIFF_ID}`

const base: RiskReviewCardData = {
  locale: 'th',
  taskId: TASK,
  number: 'RSA-2569-00012',
  supplierName: 'บริษัท ก่อสร้างไทย จำกัด',
  tier: 'HIGH',
  riskDomains: ['PRIVACY'],
  questionCount: 12,
  dueAt: new Date('2026-11-10T10:30:00Z'),
  reassigned: false,
  links: { review: `${LIFF}${liffRiskReviewPath(TASK)}` },
}

/** Every text of a card, in order */
function textsOf(message: FlexMessage): string[] {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
      Object.values(node).forEach(walk)
    }
  }
  walk(message.contents)
  return out
}

/** Every action of the card's buttons */
function actionsOf(message: FlexMessage): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>
      if (node.type === 'button') out.push(node.action as Record<string, unknown>)
      Object.values(node).forEach(walk)
    }
  }
  walk(message.contents)
  return out
}

/** The params the webhook's dispatcher hands a handler (src/server/line/webhook/postback.ts parseLinePostbackData) */
const paramsOf = (data: string) => new Map(new URLSearchParams(data))

function expectWithinLineLimits(card: FlexMessage) {
  expect(lineMessageProblems([card])).toEqual([])
  expect(jsonByteLength(card.contents)).toBeLessThanOrEqual(LINE_FLEX_BUBBLE_MAX_BYTES)
  expect(card.altText.length).toBeGreaterThan(0)
  expect(card.altText.length).toBeLessThanOrEqual(LINE_ALT_TEXT_MAX_LENGTH)
  for (const action of actionsOf(card)) {
    expect((action.label as string).length).toBeLessThanOrEqual(ACTION_LABEL_MAX_LENGTH)
    if (action.type === 'postback') {
      expect((action.data as string).length).toBeLessThanOrEqual(LINE_POSTBACK_DATA_MAX_LENGTH)
      expect((action.displayText as string).length).toBeLessThanOrEqual(LINE_POSTBACK_DISPLAY_TEXT_MAX_LENGTH)
    }
  }
}

describe('[FR-RSK-202/AC4] [BR-NOTI-12] the reviewer’s card shows the summary only (BR-NOTI-01, BR-LINE-06)', () => {
  it('number, supplier, tier, the parts the reviewer reads (GENERAL first), the question count and the due time', () => {
    const card = riskReviewCard(base)
    expect(textsOf(card)).toEqual([
      'แบบประเมินความเสี่ยงรอคุณตรวจ',
      'เลขที่',
      'RSA-2569-00012',
      'ผู้ขาย',
      'บริษัท ก่อสร้างไทย จำกัด',
      'ระดับความเสี่ยง',
      'สูง',
      'ส่วนที่คุณตรวจ',
      'ทั่วไป, ข้อมูลส่วนบุคคล',
      'จำนวนข้อ',
      '12 ข้อ',
      'กำหนด',
      '10 พ.ย. 2569 17:30 น.',
    ])
    expect(card.altText).toBe('แบบประเมินความเสี่ยงรอคุณตรวจ: RSA-2569-00012')
  })

  it('never names a sole proprietor: no supplier row when the notice carries no name', () => {
    const texts = textsOf(riskReviewCard({ ...base, supplierName: null }))
    expect(texts).not.toContain('ผู้ขาย')
    expect(texts).toContain('RSA-2569-00012')
  })

  it('leaves out what a moved task’s notice lacks, and says the task moved to the reader', () => {
    const texts = textsOf(riskReviewCard({ ...base, supplierName: null, tier: null, questionCount: null, reassigned: true }))
    expect(texts).toContain('งานตรวจนี้ย้ายมาที่คุณ')
    expect(texts).not.toContain('ระดับความเสี่ยง')
    expect(texts).not.toContain('จำนวนข้อ')
    expect(texts).toContain('ทั่วไป, ข้อมูลส่วนบุคคล')
  })

  it('in English for an English organization, with the Buddhist-era year (BR-NOTI-03)', () => {
    const card = riskReviewCard({ ...base, locale: 'en', riskDomains: ['INFOSEC', 'FINANCE'] })
    expect(textsOf(card)).toEqual(expect.arrayContaining(['A risk assessment waits for your review', 'Risk tier', 'High', 'General, Information security, Finance', '12', '10 Nov 2569 17:30']))
    expect(actionsOf(card).map((a) => a.label)).toEqual(['Pass', 'Return'])
  })

  it('"ผ่าน" is the postback v=1&a=risk_pass&t=<task> and "ตีกลับ" opens the LIFF page of the task', () => {
    const card = riskReviewCard(base)
    expect(actionsOf(card)).toEqual([
      { type: 'postback', label: 'ผ่าน', data: `v=1&a=risk_pass&t=${TASK}`, displayText: 'ผ่าน RSA-2569-00012' },
      { type: 'uri', label: 'ตีกลับ', uri: `${LIFF}/risk/reviews/${TASK}` },
    ])
  })

  it('fits LINE’s limits with the longest supplier name, every domain and the longest number, in both languages', () => {
    const longest = { ...base, supplierName: 'ก่อสร้างและวิศวกรรมโยธา'.repeat(20).slice(0, 200), riskDomains: ['PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'], number: 'R'.repeat(200) }
    for (const locale of ['th', 'en'] as const) {
      const card = riskReviewCard({ ...longest, locale })
      expectWithinLineLimits(card)
      // every domain is said in full, GENERAL first
      expect(textsOf(card)).toContain(locale === 'th' ? 'ทั่วไป, ข้อมูลส่วนบุคคล, ความปลอดภัยสารสนเทศ, ความปลอดภัยสถานที่, การเงิน' : 'General, Privacy, Information security, Premises safety, Finance')
    }
  })

  it('a task id that is not a uuid gets no postback: the pass button opens the page instead', () => {
    expect(actionsOf(riskReviewCard({ ...base, taskId: 'not-a-task' }))[0]).toEqual({ type: 'uri', label: 'ผ่าน', uri: base.links.review })
  })
})

describe('[FR-RSK-202/AC4] the postback data of "ผ่าน" is exactly v, a and t', () => {
  it('reads back the task of the card’s own data, in lower case', () => {
    expect(riskPassTaskOf(paramsOf(riskPassPostbackData(TASK)))).toBe(TASK)
    expect(riskPassTaskOf(paramsOf(`v=1&a=risk_pass&t=${TASK.toUpperCase()}`))).toBe(TASK)
    expect(RISK_PASS_POSTBACK_ACTION).toBe('risk_pass')
  })

  it('refuses any other shape: another action, version or key, a missing or extra key, a task that is not a uuid', () => {
    for (const data of [
      `v=1&a=approve&t=${TASK}`,
      `v=2&a=risk_pass&t=${TASK}`,
      `v=1&a=risk_pass&k=${TASK}`,
      'v=1&a=risk_pass',
      `v=1&a=risk_pass&t=${TASK}&d=RETURN`,
      'v=1&a=risk_pass&t=1',
      `v=1&a=risk_pass&t=${TASK}x`,
      `a=risk_pass&t=${TASK}`,
    ]) {
      expect(riskPassTaskOf(paramsOf(data)), data).toBeNull()
    }
  })

  it('the handler is registered for the action risk_pass', () => {
    expect(mocks.registered).toEqual([['risk_pass', riskPassPostbackHandler]])
  })
})

describe('[FR-RSK-202/AC4] [BR-SOD-16] a tap decides as the LINE-linked member on LINE_CHAT, once per LINE event', () => {
  const request = (memberId: string | null, data = riskPassPostbackData(TASK)) => ({
    organizationId: '01928c6e-7f3a-7b2c-9d4e-0000000000a1',
    eventId: '01928c6e-7f3a-7b2c-9d4e-0000000000e1',
    webhookEventId: '01HXYZWEBHOOKEVENT0000000001',
    lineUserId: 'U0123456789abcdef0123456789abcdef',
    memberId,
    action: 'risk_pass',
    params: paramsOf(data),
    replyToken: 'reply-token',
    receivedAt: new Date('2026-11-09T03:00:00Z'),
    redelivery: false,
  })
  const context = { clock: { now: () => new Date('2026-11-09T03:00:01Z') }, channel: { liffId: LIFF_ID } } as never
  const said = () => (mocks.answer.mock.calls.at(-1) as unknown as [unknown, unknown, Array<{ text: string }>])[2][0]!.text

  beforeEach(() => {
    mocks.decide.mockReset()
    mocks.answer.mockClear()
  })

  it('passes with the member, channel LINE_CHAT and the LINE event as the idempotency key, and says what follows', async () => {
    mocks.decide.mockResolvedValue({ ok: true, data: { taskId: TASK, decision: 'PASS', assessment: 'IN_REVIEW' } })
    const outcome = await riskPassPostbackHandler(request('01928c6e-7f3a-7b2c-9d4e-0000000000b1'), context)
    expect(outcome).toEqual({ status: 'PROCESSED' })
    const [ctx, input, options] = mocks.decide.mock.calls[0]!
    expect(ctx).toMatchObject({ actor: { type: 'USER', memberId: '01928c6e-7f3a-7b2c-9d4e-0000000000b1' }, channel: 'LINE_CHAT' })
    expect(input).toEqual({ taskId: TASK, decision: 'PASS' })
    expect(options).toEqual({ idempotencyKey: 'line-postback:01HXYZWEBHOOKEVENT0000000001' })
    expect(said()).toBe(`ผ่านแล้ว: แบบประเมินความเสี่ยง RSA-2569-00012\nเมื่อ 9 พ.ย. 2569 10:00 น.\nรอผู้ตรวจส่วนอื่น\n${LIFF}/risk/reviews/${TASK}`)
  })

  it('a LINE user linked to nobody decides nothing and is pointed at linking LINE', async () => {
    const outcome = await riskPassPostbackHandler(request(null), context)
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(outcome).toEqual({ status: 'PROCESSED', reason: 'NOT_LINKED' })
    expect(said()).toBe(`ปุ่มนี้ใช้ได้เฉพาะผู้ตรวจที่ได้รับงานนี้หรือผู้รักษาการแทน จากบัญชี LINE ที่ผูกไว้\n${LIFF}/link`)
  })

  it('data of another shape is skipped before anything is read or decided', async () => {
    expect(await riskPassPostbackHandler(request('m', `v=1&a=risk_pass&t=${TASK}&x=1`), context)).toEqual({ status: 'SKIPPED', reason: 'POSTBACK_INVALID' })
    expect(mocks.decide).not.toHaveBeenCalled()
    expect(mocks.answer).not.toHaveBeenCalled()
  })

  it('someone else’s task learns nothing of it; a busy database is tried again', async () => {
    mocks.decide.mockResolvedValue({ ok: false, error: { code: 'FORBIDDEN', message: 'x' } })
    expect(await riskPassPostbackHandler(request('01928c6e-7f3a-7b2c-9d4e-0000000000b2'), context)).toEqual({ status: 'PROCESSED', reason: 'FORBIDDEN' })
    expect(said()).not.toContain('RSA-')
    expect(said()).not.toContain(TASK)
    mocks.decide.mockResolvedValue({ ok: false, error: { code: 'RATE_LIMITED', message: 'x' } })
    await expect(riskPassPostbackHandler(request('01928c6e-7f3a-7b2c-9d4e-0000000000b2'), context)).rejects.toThrow(/RATE_LIMITED/)
  })
})

describe('[FR-RSK-202/AC4] what a refused tap says in the chat', () => {
  it('decided already: by whom and when (§9.3 "ดำเนินการแล้วโดย … เมื่อ …"), in the reader’s language', () => {
    const error = { code: 'INVALID_STATE_TRANSITION' as const, message: 'x', details: { name: 'สมชาย ใจดี', nameEn: 'Somchai Jaidee', time: '2026-11-09T03:00:00.000Z' } }
    expect(riskPassAnswerMessage(riskPassRefusalOf(error, 'th'), 'th', null).text).toBe('งานตรวจนี้ดำเนินการแล้วโดย สมชาย ใจดี เมื่อ 9 พ.ย. 2569 10:00 น.')
    expect(riskPassAnswerMessage(riskPassRefusalOf(error, 'en'), 'en', null).text).toBe('This review was already done by Somchai Jaidee on 9 Nov 2569 10:00.')
    // cancelled, or the round is over: nobody decided this task
    expect(riskPassAnswerMessage(riskPassRefusalOf({ code: 'INVALID_STATE_TRANSITION', message: 'x', details: { from: 'CANCELLED' } }, 'th'), 'th', null).text).toBe('งานตรวจนี้ปิดแล้ว ไม่ต้องตรวจต่อ')
  })

  it('separation of duties (BR-SOD-16), not theirs, and anything else', () => {
    expect(riskPassRefusalOf({ code: 'SOD_VIOLATION', message: 'x' }, 'th')).toEqual({ kind: 'SOD_VIOLATION' })
    expect(riskPassRefusalOf({ code: 'NOT_FOUND', message: 'x' }, 'th')).toEqual({ kind: 'NOT_YOURS' })
    expect(riskPassRefusalOf({ code: 'MODULE_DISABLED', message: 'x' }, 'th')).toEqual({ kind: 'NOT_DECIDED' })
    expect(riskPassAnswerMessage({ kind: 'SOD_VIOLATION' }, 'en', 'https://bcs.example/x').text).toBe('You cannot review this assessment: you opened or filled it in (separation of duties).\nhttps://bcs.example/x')
  })
})

describe('[FR-RSK-202/AC4] the LIFF page of a reviewer’s task', () => {
  it('is where a reviewer’s workspace page leads in LINE (its reminders’ links too)', () => {
    expect(liffRiskReviewPath(TASK)).toBe(`/risk/reviews/${TASK}`)
    expect(liffPathFor(`/risk/reviews/${TASK}`)).toBe(`/risk/reviews/${TASK}`)
    for (const page of ['/risk/reviews', `/risk/reviews/${TASK}/x`, '/risk/reviews/../admin']) expect(liffPathFor(page)).toBeNull()
  })

  it('says a refusal of riskReview.decide where the form shows it', () => {
    const words: LiffRiskWords = { locale: 'th', error: (key, values) => `${key}:${values.name}:${values.time}`, time: (iso) => `t(${iso})` }
    expect(liffRiskResultOf({ code: 'INVALID_STATE_TRANSITION', message: 'x', details: { name: 'ก', nameEn: 'A', time: '2026-11-09T03:00:00.000Z' } }, words)).toEqual({ ok: false, at: 'closed', text: 'done:ก:t(2026-11-09T03:00:00.000Z)' })
    expect(liffRiskResultOf({ code: 'INVALID_STATE_TRANSITION', message: 'x', details: { name: 'ก', nameEn: 'A', time: '2026-11-09T03:00:00.000Z' } }, { ...words, locale: 'en' }).text).toBe('done:A:t(2026-11-09T03:00:00.000Z)')
    expect(liffRiskResultOf({ code: 'INVALID_STATE_TRANSITION', message: 'x' }, words)).toEqual({ ok: false, at: 'closed', text: 'closed:-:-' })
    expect(liffRiskResultOf({ code: 'VALIDATION_FAILED', message: 'x', details: { field: 'reason' } }, words)).toEqual({ ok: false, at: 'reason', text: 'reason:-:-' })
    expect(liffRiskResultOf({ code: 'SOD_VIOLATION', message: 'x' }, words)).toEqual({ ok: false, at: 'form', text: 'sod:-:-' })
    expect(liffRiskResultOf({ code: 'FORBIDDEN', message: 'x' }, words)).toEqual({ ok: false, at: 'closed', text: 'notYours:-:-' })
    expect(liffRiskResultOf({ code: 'UNAUTHENTICATED', message: 'x' }, words)).toEqual({ ok: false, at: 'form', text: 'signedOut:-:-', signedOut: true })
    expect(liffRiskResultOf({ code: 'INTERNAL', message: 'x' }, words)).toEqual({ ok: false, at: 'form', text: 'other:-:-' })
  })
})
