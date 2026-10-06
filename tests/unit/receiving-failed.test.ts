import { createTranslator } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'
import { liffFailureText, type FailureMapping, type LiffFailureWords } from '@/ui/liff/receiving/failure-text'
import { failedKey, NO_ANSWER, noAnswerKey, type ReceivingAction } from '@/ui/receiving/failed'
import { receivingErrorKey, receivingErrorValues, toReceivingFailure, type ReceivingFailure } from '@/ui/receiving/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// D-05 (/liff/gr/[id], item 4) · §9.9 rule 7: what the receiving forms say when an action does not go through, in words
// of the step it came from. Step 1's check ("ตรวจสอบก่อนบันทึก", gr preview) writes nothing: when it gets no answer from
// the server — the signal drops on site — or an answer the screen does not know, it says that nothing has been recorded
// yet and asks for the check again, never "บันทึกไม่สำเร็จ" (not recorded). Recording (step 2's receipt, a request to
// close short) that gets no answer cannot know whether the server recorded it before the answer was lost (D-05 round 4):
// it says it is not certain, and to press the same button again without changing anything — the same key, so never
// recorded twice; "บันทึกไม่สำเร็จ" stays the words of a recording the server answered and the screen does not know.
// The same on the web form (src/ui/receiving/receive-form.tsx, through receivingErrorKey with its step) and in the bar of
// the LIFF page (src/ui/liff/receiving/receive-flow.tsx, through liffFailureText, which says no answer without fetching
// the mapping of refusals, and words a refusal whose words cannot be fetched by its step). Pure parts only: the forms
// run in the browser in tests/e2e/receiving.spec.ts and tests/e2e/liff-gr.spec.ts.

const MESSAGES = { th, en } as const
type Locale = keyof typeof MESSAGES

const CHECK_FAILED = {
  th: 'ตรวจสอบไม่สำเร็จ ยังไม่ได้บันทึกอะไร ตรวจการเชื่อมต่อแล้วกดตรวจสอบก่อนบันทึกอีกครั้ง',
  en: 'The check did not go through, and nothing has been recorded yet. Check your connection and press Check before recording again.',
} as const
const FAILED = { th: 'บันทึกไม่สำเร็จ ตรวจการเชื่อมต่อแล้วลองอีกครั้ง', en: 'Not recorded. Check your connection and try again.' } as const
const NO_ANSWER_WORDS = {
  th: 'ไม่ได้รับคำตอบจากระบบ จึงไม่แน่ใจว่าบันทึกแล้วหรือยัง ตรวจการเชื่อมต่อแล้วกดปุ่มเดิมอีกครั้งโดยไม่แก้อะไร ระบบไม่บันทึกซ้ำ',
  en: 'No answer came back, so it is not certain it was recorded. Check your connection and press the same button again without changing anything; it is not recorded twice.',
} as const

const errorsIn = (locale: Locale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: 'receiving.errors' })

/** What the web form's bar shows for a failure of this step (its useFailureText) */
const webText = (failure: ReceivingFailure, action: ReceivingAction, locale: Locale = 'th') => errorsIn(locale)(receivingErrorKey(failure, action), receivingErrorValues(failure))

/** The words the LIFF flow hands to liffFailureText */
function liffWords(locale: Locale = 'th'): LiffFailureWords {
  const errors = errorsIn(locale)
  const liff = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'liffReceiving' })
  return { error: (key, values) => errors(key, values), sessionEnded: () => liff('sessionEnded') }
}

/** The mapping as the page fetches it */
const fetched = (): Promise<FailureMapping> => import('@/ui/receiving/outcome')
/** No signal: the mapping cannot be fetched */
const offline = () => vi.fn((): Promise<FailureMapping> => Promise.reject(new TypeError('Failed to fetch dynamically imported module')))

const SOMETHING_NEW = toReceivingFailure({ code: 'SOMETHING_NEW' })
/** Refusals the server explains: their words are the same whichever step they came from */
const EXPLAINED: readonly ReceivingFailure[] = [
  toReceivingFailure({ code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-02' } }),
  toReceivingFailure({ code: 'RATE_LIMITED' }),
  toReceivingFailure({ code: 'VALIDATION_FAILED', details: { reason: 'EXCESS_DISPOSITION_REQUIRED', excess: '1' } }),
  toReceivingFailure({ code: 'INTERNAL', details: { requestId: 'req-2569-0815' } }),
]

describe('[FR-P2P-006/AC1] [FR-PLT-002/AC2] the web receiving form says which step did not go through: the check records nothing, the receipt was not recorded', () => {
  it.each(['th', 'en'] as const)('a check that gets no answer says that nothing has been recorded yet, and to press the check again (%s)', (locale) => {
    expect(receivingErrorKey(NO_ANSWER, 'check')).toBe('CHECK_FAILED')
    expect(webText(NO_ANSWER, 'check', locale)).toBe(CHECK_FAILED[locale])
    expect(webText(NO_ANSWER, 'check', locale)).not.toBe(FAILED[locale])
    // The button it names is the one step 1 shows
    expect(webText(NO_ANSWER, 'check', locale)).toContain(MESSAGES[locale].receiving.form.toReview)
  })

  it.each(['th', 'en'] as const)('a receipt that gets no answer never says it was not recorded: it is not certain, so the same button again, unchanged (%s)', (locale) => {
    expect(receivingErrorKey(NO_ANSWER, 'record')).toBe('NO_ANSWER')
    expect(webText(NO_ANSWER, 'record', locale)).toBe(NO_ANSWER_WORDS[locale])
    expect(webText(NO_ANSWER, 'record', locale)).not.toBe(FAILED[locale])
  })

  it('a request to close short names no step: it records, so it keeps the receipt’s words — uncertain with no answer, not recorded for an answer the screen does not know', () => {
    expect(receivingErrorKey(NO_ANSWER)).toBe('NO_ANSWER')
    expect(receivingErrorKey(SOMETHING_NEW)).toBe('FAILED')
  })

  it('an answer the screen does not know is an answer: worded for its step, the receipt not recorded', () => {
    expect(receivingErrorKey(SOMETHING_NEW, 'check')).toBe('CHECK_FAILED')
    expect(receivingErrorKey(SOMETHING_NEW, 'record')).toBe('FAILED')
    expect(failedKey('check')).toBe('CHECK_FAILED')
    expect(failedKey('record')).toBe('FAILED')
    expect(noAnswerKey('check')).toBe('CHECK_FAILED')
    expect(noAnswerKey('record')).toBe('NO_ANSWER')
  })

  it('a refusal the server explains reads the same on either step, its values filled in', () => {
    for (const failure of EXPLAINED) expect(receivingErrorKey(failure, 'check'), failure.code).toBe(receivingErrorKey(failure, 'record'))
    expect(webText(EXPLAINED[0]!, 'check')).toBe(th.receiving.errors.SOD_APPROVER)
    expect(webText(EXPLAINED[2]!, 'check')).toBe(th.receiving.errors.EXCESS_CHOICE.replace('{excess}', '1'))
    expect(webText(EXPLAINED[3]!, 'check')).toContain('req-2569-0815')
  })
})

describe('[FR-LINE-003/AC3] [FR-P2P-006/AC1] the bar of the LIFF receiving page says which step did not go through, in the web form’s words', () => {
  it.each(['th', 'en'] as const)('a check that gets no answer says that nothing has been recorded yet, without fetching the mapping of refusals (%s)', async (locale) => {
    const load = offline()
    expect(await liffFailureText(NO_ANSWER, 'check', liffWords(locale), load)).toBe(CHECK_FAILED[locale])
    expect(load).not.toHaveBeenCalled()
  })

  it.each(['th', 'en'] as const)('a receipt that gets no answer says it is not certain it was recorded, and to press the same button again unchanged, without fetching the mapping either (%s)', async (locale) => {
    const load = offline()
    expect(await liffFailureText(NO_ANSWER, 'record', liffWords(locale), load)).toBe(NO_ANSWER_WORDS[locale])
    expect(load).not.toHaveBeenCalled()
  })

  it.each(['th', 'en'] as const)('a refusal whose words cannot be fetched (the signal dropped) is worded for its step (%s)', async (locale) => {
    const load = offline()
    const busy = toReceivingFailure({ code: 'RATE_LIMITED' })
    expect(await liffFailureText(busy, 'check', liffWords(locale), load)).toBe(CHECK_FAILED[locale])
    expect(await liffFailureText(busy, 'record', liffWords(locale), load)).toBe(FAILED[locale])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a refusal the server explains is said as the web form says it, on either step; one the screen does not know reads like no answer', async () => {
    for (const failure of [...EXPLAINED, SOMETHING_NEW, NO_ANSWER]) {
      for (const action of ['check', 'record'] as const) {
        expect(await liffFailureText(failure, action, liffWords(), fetched), `${failure.code} ${action}`).toBe(webText(failure, action))
      }
    }
    expect(await liffFailureText(SOMETHING_NEW, 'check', liffWords(), fetched)).toBe(CHECK_FAILED.th)
    expect(await liffFailureText(SOMETHING_NEW, 'record', liffWords(), fetched)).toBe(FAILED.th)
  })

  it('fetches the mapping of refusals itself when a refusal comes', async () => {
    expect(await liffFailureText(toReceivingFailure({ code: 'RATE_LIMITED' }), 'check', liffWords())).toBe(th.receiving.errors.BUSY)
  })

  it.each(['th', 'en'] as const)('a LIFF session that has ended says so on either step, and how to go on (%s)', async (locale) => {
    const load = offline()
    for (const action of ['check', 'record'] as const) {
      expect(await liffFailureText({ ok: false, code: 'UNAUTHENTICATED' }, action, liffWords(locale), load)).toBe(MESSAGES[locale].liffReceiving.sessionEnded)
    }
    expect(load).not.toHaveBeenCalled()
  })
})
