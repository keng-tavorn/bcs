import { describe, expect, it } from 'vitest'
import { checkAiText, type TextValue } from '@/core/ai-checks'
import { DECISION_ADVICE_WORDS } from '@/lib/ai-config'
import { FOLLOW_UP_QUIET_MS, MS_PER_HOUR } from '@/lib/constants'
import { dueForFollowUp, FOLLOW_UP_MAX, followUpHold } from '@/lib/follow-up'
import { LINE_TEMPLATES } from '@/server/notifications/line-templates'
import { renderNotification } from '@/server/notifications/templates'
import en from '../../messages/src/en/followUp.json'
import th from '../../messages/src/th/followUp.json'

// NEW-124 (ADR-082): the rules of the follow-up assistant that need no database — when a nudge may go, which tasks it
// lists, that its drafts pass the checker of BR-AI-27 like an AI's text would, and that LINE, push and e-mail carry the
// document's number only while the bell carries the words (BR-NOTI-01).

const NOW = new Date('2026-10-12T03:00:00Z')
const NEXT_DAY = new Date('2026-10-12T17:00:00Z')
const at = (hours: number) => new Date(NOW.getTime() + hours * MS_PER_HOUR)

describe('[FR-VIS-001/AC6] a nudge a task a day, and none right after the holder was told', () => {
  it('goes when nobody nudged today and the holder was told long ago', () => {
    expect(followUpHold({ now: NOW, nextDayStart: NEXT_DAY, sentToday: 0, lastToldAt: at(-3) })).toBeNull()
    expect(followUpHold({ now: NOW, nextDayStart: NEXT_DAY, sentToday: 0, lastToldAt: null })).toBeNull()
  })

  it('waits for the next day of the organization after one nudge, whoever sent it', () => {
    expect(followUpHold({ now: NOW, nextDayStart: NEXT_DAY, sentToday: 1, lastToldAt: null })).toEqual({ reason: 'SENT_TODAY', nextAt: NEXT_DAY })
  })

  it('waits the quiet time after the holder was told, to the millisecond', () => {
    const told = at(-1)
    expect(followUpHold({ now: NOW, nextDayStart: NEXT_DAY, sentToday: 0, lastToldAt: told })).toEqual({ reason: 'TOLD_RECENTLY', nextAt: new Date(told.getTime() + FOLLOW_UP_QUIET_MS) })
    expect(followUpHold({ now: new Date(told.getTime() + FOLLOW_UP_QUIET_MS), nextDayStart: NEXT_DAY, sentToday: 0, lastToldAt: told })).toBeNull()
  })

  it('names the later time when both hold it back', () => {
    expect(followUpHold({ now: NOW, nextDayStart: NEXT_DAY, sentToday: 1, lastToldAt: at(-1) })?.reason).toBe('SENT_TODAY')
    const lateNight = new Date('2026-10-12T16:30:00Z')
    expect(followUpHold({ now: lateNight, nextDayStart: NEXT_DAY, sentToday: 1, lastToldAt: new Date(lateNight.getTime() - MS_PER_HOUR) })).toEqual({
      reason: 'TOLD_RECENTLY',
      nextAt: new Date(lateNight.getTime() + MS_PER_HOUR),
    })
  })
})

describe('[FR-VIS-001/AC4] the tasks the assistant lists', () => {
  it('past their due time, or due within a day; never one without a due time', () => {
    expect(dueForFollowUp(at(-30), NOW)).toBe(true)
    expect(dueForFollowUp(at(24), NOW)).toBe(true)
    expect(dueForFollowUp(new Date(at(24).getTime() + 1), NOW)).toBe(false)
    expect(dueForFollowUp(null, NOW)).toBe(false)
  })
})

/** Each {name} of a message as a placeholder of the checker */
const asChecked = (template: string) => template.replace(/\{(\w+)\}/g, (_, name: string) => `{{v:${name}}}`)
/** A long value for every name a draft fills in, so the length is checked against what a draft can become */
const values: Record<string, TextValue> = Object.fromEntries(['name', 'document', 'number', 'due'].map((k) => [k, { kind: 'text', value: 'x'.repeat(40) }]))

describe('[FR-VIS-001/AC5] the drafts pass the text checker of BR-AI-27', () => {
  for (const [lang, messages] of [['th', th], ['en', en]] as const) {
    it(`every ${lang} draft: values from code only, no advice to decide, within a nudge`, () => {
      for (const key of ['OVERDUE', 'DUE_SOON'] as const) {
        const checked = checkAiText([asChecked(messages.draft[key])], values, { maxSentences: 1, maxChars: FOLLOW_UP_MAX }, DECISION_ADVICE_WORDS)
        expect(checked, `${lang} ${key}`).toEqual({ ok: true, rendered: [expect.any(String)] })
      }
    })
  }

  it('the checker would refuse a draft that wrote a number or advised a decision', () => {
    expect(checkAiText([asChecked('ภายใน 2 วัน {number}')], values, { maxSentences: 1, maxChars: FOLLOW_UP_MAX }, DECISION_ADVICE_WORDS)).toMatchObject({ ok: false, reason: 'DIGIT_OUTSIDE_PLACEHOLDER' })
    expect(checkAiText([asChecked('ควรอนุมัติ {number}')], values, { maxSentences: 1, maxChars: FOLLOW_UP_MAX }, DECISION_ADVICE_WORDS)).toMatchObject({ ok: false, reason: 'DECISION_ADVICE' })
  })
})

describe('[FR-VIS-001/AC5] the notice of a nudge', () => {
  const data = { subjectType: 'REQUEST', subjectId: 'r1', number: 'PR-2569-00012', taskId: 't1', senderTh: 'สมชาย ใจดี', senderEn: 'Somchai Jaidee', text: 'ขอติดตามคำขอเครื่องพิมพ์ราคา 5,000 บาท' }
  const n = (templateKey: string) => ({ templateKey, data, subjectType: 'REQUEST', subjectId: 'r1' })

  it('outside BCS: the kind and number of the document and a link to the task, without the words or who sent them', () => {
    for (const key of ['task.follow_up', 'task.follow_up_email']) {
      const outside = renderNotification(n(key), 'th')
      expect(outside).toEqual({ title: 'มีข้อความติดตามงานอนุมัติคำขอ PR-2569-00012', body: 'เปิด BCS เพื่ออ่านข้อความและพิจารณา', href: '/tasks/t1' })
      expect(JSON.stringify(renderNotification(n(key), 'en'))).not.toMatch(/Somchai|5,000/)
    }
  })

  it('in the bell: who sent it and their words', () => {
    expect(renderNotification(n('task.follow_up'), 'th', 'IN_APP')).toEqual({ title: 'สมชาย ใจดี ติดตามงานอนุมัติคำขอ PR-2569-00012', body: data.text, href: '/tasks/t1' })
    expect(renderNotification({ ...n('task.follow_up'), data: { ...data, subjectType: 'PURCHASE_ORDER', number: 'PO-2569-00003' } }, 'en', 'IN_APP').title).toBe('Somchai Jaidee follows up on your approval of purchase order PO-2569-00003')
  })

  it('"ทาง LINE" goes the way of a task’s notice; "ทางอีเมล" by e-mail alone', () => {
    expect(LINE_TEMPLATES.has('task.follow_up')).toBe(true)
    expect(LINE_TEMPLATES.has('task.follow_up_email')).toBe(false)
  })
})
