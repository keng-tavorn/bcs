import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import { liffTaskResult } from '@/app/liff/tasks/_lib/result'
import { formatDateTime } from '@/ui/format'
import { placePolicyRefusal } from '@/ui/liff/tasks/policy-refusal'
import { liffTaskAction, pinComplete } from '@/ui/liff/tasks/shared'
import { toActionFailure, type ActionOutcome } from '@/ui/tasks/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S5-06 · what the LIFF decision page tells the member after a decision was sent (FR-LINE-003 AC2, FR-AUTH-005 AC2 AC3,
// FR-DOA-004 AC2, FR-DOA-009 AC3): the command's outcome in the words of the web decision page (tasks.errors), in the
// member's language with the tries left, the time and the name filled in, placed where the LIFF form shows it — at the
// PIN field, at the boundary table's tick, as a task closed meanwhile, or by the button with the way to set a PIN or to
// open the page again. The page's ?action= from a LINE card (§9.3) and the PIN's length check before sending.

const MESSAGES = { th, en } as const
type Locale = keyof typeof MESSAGES

function answered(outcome: ActionOutcome, locale: Locale = 'th') {
  const t = createTranslator({ locale, messages: MESSAGES[locale], namespace: 'tasks.errors' })
  return liffTaskResult(outcome, { error: (key, values) => t(key, values), time: (iso) => formatDateTime(locale, iso) })
}

const LOCKED_UNTIL = '2026-10-05T08:15:00.000Z'

describe('[FR-LINE-003/AC2] [FR-AUTH-005/AC2] the LIFF form is told what happened, where it belongs, in the member’s words', () => {
  it('a decision that went through says nothing more: the page shows what was decided', () => {
    expect(answered({ ok: true, documentStatus: 'APPROVED' })).toEqual({ ok: true })
  })

  it.each(['th', 'en'] as const)('a PIN that is not six digits, or wrong with the tries left, is said at the PIN field (%s)', (locale) => {
    expect(answered(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin' } }), locale)).toEqual({ ok: false, at: 'pin', text: MESSAGES[locale].tasks.errors.PIN })
    const wrong = answered(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin', reason: 'WRONG', attemptsLeft: 3 } }), locale)
    expect(wrong).toMatchObject({ ok: false, at: 'pin' })
    expect(wrong.ok ? '' : wrong.text).toBe(
      locale === 'th' ? 'PIN ไม่ถูกต้อง ใส่ผิดได้อีก 3 ครั้ง ถ้าผิดครบ PIN จะถูกล็อก 15 นาที' : 'The PIN is wrong. 3 more wrong tries and the PIN locks for 15 minutes.',
    )
  })

  it('[FR-AUTH-005/AC3] a locked PIN says until when, by the button; the time is the page’s Thai time', () => {
    const locked = answered(toActionFailure({ code: 'STEP_UP_LOCKED', details: { time: LOCKED_UNTIL } }))
    expect(locked).toEqual({ ok: false, at: 'form', text: th.tasks.errors.PIN_LOCKED.replace('{time}', formatDateTime('th', LOCKED_UNTIL)) })
    expect(locked.ok ? '' : locked.text).toContain('15:15')
  })

  it('[FR-AUTH-005/AC1] a member without a PIN is told to set one, and the form shows where', () => {
    expect(answered(toActionFailure({ code: 'STEP_UP_REQUIRED', details: { reason: 'PIN_NOT_SET' } }))).toEqual({ ok: false, at: 'form', text: th.tasks.errors.PIN_NOT_SET, pinNotSet: true })
  })

  it('[FR-DOA-004/AC2] a task decided meanwhile names who decided it and when, and the page shows it as it is now', () => {
    const decided = answered({ ok: false, code: 'INVALID_STATE_TRANSITION', name: 'วิไล สนับสนุน', time: '2026-10-05T03:30:00.000Z' })
    expect(decided).toEqual({ ok: false, at: 'closed', text: `ดำเนินการแล้วโดย วิไล สนับสนุน เมื่อ ${formatDateTime('th', '2026-10-05T03:30:00.000Z')}` })
    expect(answered({ ok: false, code: 'NOT_FOUND' })).toEqual({ ok: false, at: 'closed', text: th.tasks.errors.NOT_FOUND })
    expect(answered({ ok: false, code: 'INVALID_STATE_TRANSITION' })).toEqual({ ok: false, at: 'closed', text: th.tasks.errors.STATE })
  })

  it('[FR-DOA-009/AC3] a DOA version approved without the tick is told at the tick; a table that changed takes the tick back', () => {
    expect(answered(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' } }))).toEqual({
      ok: false,
      at: 'tick',
      text: th.tasks.errors.BOUNDARY_NOT_CONFIRMED,
    })
    expect(answered(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_TABLE_CHANGED' } }))).toEqual({
      ok: false,
      at: 'form',
      text: th.tasks.errors.BOUNDARY_TABLE_CHANGED,
      untick: true,
    })
  })

  it('an ended session, separation of duties and the other refusals are said by the button, with what to do', () => {
    expect(answered({ ok: false, code: 'UNAUTHENTICATED' })).toEqual({ ok: false, at: 'form', text: th.tasks.errors.UNAUTHENTICATED, signedOut: true })
    expect(answered(toActionFailure({ code: 'SOD_VIOLATION', details: { rule: 'SOD-01' } }))).toEqual({ ok: false, at: 'form', text: th.tasks.errors.SOD.replace('{rule}', 'SOD-01') })
    expect(answered(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'reason' } }))).toEqual({ ok: false, at: 'form', text: th.tasks.errors.REASON })
    expect(answered(toActionFailure({ code: 'INTERNAL', details: { requestId: 'req-42' } }))).toEqual({ ok: false, at: 'form', text: th.tasks.errors.INTERNAL.replace('{requestId}', 'req-42') })
  })

  it('[NFR-SEC-09] never carries more than the screen-safe parts of an error (no PIN, no developer message)', () => {
    const outcome = toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin', reason: 'WRONG', attemptsLeft: 2, pin: '739164', message: 'argon2 mismatch' } })
    expect(JSON.stringify(answered(outcome))).not.toMatch(/739164|argon2/)
  })
})

describe('[FR-DOA-009/AC3] where the LIFF bar of a DOA version says a refusal of approving it', () => {
  const missingTick = answered(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' } }))
  const changed = th.tasks.errors.BOUNDARY_TABLE_CHANGED

  it('a missing tick is said at the tick when the page shows the boundary table', () => {
    if (missingTick.ok) throw new Error('a refusal was expected')
    expect(placePolicyRefusal(missingTick, 'doa-boundaries', changed)).toEqual({ at: 'tick', text: th.tasks.errors.BOUNDARY_NOT_CONFIRMED })
  })

  it('when the page shows no table, the bar says the table appeared after the page was opened — never “tick the table”', () => {
    if (missingTick.ok) throw new Error('a refusal was expected')
    const placed = placePolicyRefusal(missingTick, null, changed)
    expect(placed).toEqual({ at: 'bar', failure: { ok: false, at: 'form', text: changed } })
    expect(JSON.stringify(placed)).not.toContain(th.tasks.errors.BOUNDARY_NOT_CONFIRMED)
    // The same words as the web decision page, in English too
    expect(placePolicyRefusal(missingTick, null, en.tasks.errors.BOUNDARY_TABLE_CHANGED)).toMatchObject({ at: 'bar', failure: { text: en.tasks.errors.BOUNDARY_TABLE_CHANGED } })
  })

  it('anything else stays in the bar as it came: a changed table (its tick taken back), a lock, separation of duties', () => {
    for (const outcome of [
      toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_TABLE_CHANGED' } }),
      toActionFailure({ code: 'STEP_UP_LOCKED', details: { time: LOCKED_UNTIL } }),
      toActionFailure({ code: 'SOD_VIOLATION', details: { rule: 'SOD-01' } }),
    ]) {
      const failure = answered(outcome)
      if (failure.ok) throw new Error('a refusal was expected')
      expect(placePolicyRefusal(failure, 'doa-boundaries', changed)).toEqual({ at: 'bar', failure })
      expect(placePolicyRefusal(failure, null, changed)).toEqual({ at: 'bar', failure })
    }
  })
})

describe('[§9.3] a LINE card’s button opens the task with its choice ready, and nothing else', () => {
  it('reads ?action=approve and ?action=reject, and opens the page as it is for anything else', () => {
    expect(liffTaskAction('approve')).toBe('approve')
    expect(liffTaskAction('reject')).toBe('reject')
    for (const other of [undefined, '', 'APPROVE', 'return', 'decide', ['approve'], ['approve', 'reject']]) expect(liffTaskAction(other), String(other)).toBeNull()
  })
})

describe('[FR-AUTH-005/AC1] the PIN is checked for its length and digits before it is sent', () => {
  it('takes exactly the PIN length in digits', () => {
    expect(pinComplete('739164', 6)).toBe(true)
    for (const pin of ['', '73916', '7391640', '73916a', ' 39164', '７３９１６４']) expect(pinComplete(pin, 6), pin).toBe(false)
  })
})
