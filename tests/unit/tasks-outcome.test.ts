import { describe, expect, it } from 'vitest'
import { NO_ANSWER, requestErrorKey, taskErrorKey, toActionFailure } from '@/ui/tasks/outcome'
import en from '../../messages/en.json'
import th from '../../messages/th.json'

// S2-12: what a decision or a requester action tells the screen when it fails (§14.2, §9.9 rule 7): a code the screen
// turns into a message that says what happened and how to fix it, with only the safe parts of the details.

describe('[FR-DOA-004/AC2] a task decided already is reported with who decided it and when', () => {
  it('keeps the name and the time of INVALID_STATE_TRANSITION and maps it to "already decided by … at …"', () => {
    const failure = toActionFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'APPROVED', command: 'approval.approve', name: 'วีระ ปฏิบัติการ', time: '2026-10-05T03:00:00.000Z' } })
    expect(failure).toEqual({ ok: false, code: 'INVALID_STATE_TRANSITION', name: 'วีระ ปฏิบัติการ', time: '2026-10-05T03:00:00.000Z' })
    expect(taskErrorKey(failure)).toBe('DECIDED')
    // Without a decider (a task that was cancelled or moved) the screen asks for a reload instead
    expect(taskErrorKey(toActionFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'CANCELLED' } }))).toBe('STATE')
  })
})

describe('[FR-DOA-004/AC1] decisions explain every refusal', () => {
  it.each([
    [{ code: 'VALIDATION_FAILED', details: { field: 'reason' } }, 'REASON'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'question' } }, 'QUESTION'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'pin' } }, 'PIN'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'effectiveFrom', reason: 'LATER_VERSION_SCHEDULED' } }, 'LATER_VERSION'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'decision', reason: 'RETURN_NOT_ALLOWED' } }, 'FAILED'],
    // A question asked on a policy task (those are approved or rejected only, BR-DOA-15)
    [{ code: 'VALIDATION_FAILED', details: { field: 'taskId', reason: 'SUBJECT' } }, 'SUBJECT'],
    [{ code: 'FORBIDDEN', details: { capability: 'approval.decide' } }, 'FORBIDDEN'],
    [{ code: 'FORBIDDEN', details: { reason: 'CHANNEL' } }, 'CHANNEL'],
    [{ code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01' } }, 'SOD'],
    [{ code: 'STEP_UP_REQUIRED', details: {} }, 'STEP_UP'],
    [{ code: 'APPROVER_NOT_FOUND', details: { stepNo: 2 } }, 'APPROVER_NOT_FOUND'],
    [{ code: 'NOT_FOUND' }, 'NOT_FOUND'],
    [{ code: 'RATE_LIMITED', details: { requestId: 'r-1' } }, 'BUSY'],
    [{ code: 'IDEMPOTENCY_CONFLICT', details: { idempotencyKey: 'k' } }, 'CONFLICT'],
    [{ code: 'INTERNAL', details: { requestId: 'r-2' } }, 'INTERNAL'],
    [{ code: 'MODULE_DISABLED' }, 'FAILED'],
  ] as const)('%j → %s', (error, key) => {
    expect(taskErrorKey(toActionFailure(error))).toBe(key)
  })

  it('[FR-AUTH-005/AC2] [FR-AUTH-005/AC3] tells a wrong, locked or missing PIN apart, with the tries left and the end of the lock', () => {
    // The step-up's refusals as src/server/auth/step-up.ts words them (stepUpRefusalError)
    const wrong = toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin', reason: 'WRONG', attemptsLeft: 3 } })
    expect(wrong).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'pin', reason: 'WRONG', attemptsLeft: 3 })
    expect(taskErrorKey(wrong)).toBe('PIN_INVALID')
    const locked = toActionFailure({ code: 'STEP_UP_LOCKED', details: { method: 'PIN', time: '2026-10-05T03:15:00.000Z' } })
    expect(locked).toEqual({ ok: false, code: 'STEP_UP_LOCKED', time: '2026-10-05T03:15:00.000Z' })
    expect(taskErrorKey(locked)).toBe('PIN_LOCKED')
    expect(taskErrorKey(toActionFailure({ code: 'STEP_UP_REQUIRED', details: { method: 'PIN', reason: 'PIN_NOT_SET' } }))).toBe('PIN_NOT_SET')
    // The decision found no step-up for its document (expired, or used already): enter the PIN again
    expect(taskErrorKey(toActionFailure({ code: 'STEP_UP_REQUIRED', details: { subjectType: 'REQUEST', method: 'PIN' } }))).toBe('STEP_UP')
    // Only a count of tries passes: never text, a negative or a fraction
    expect(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin', attemptsLeft: '3' } })).not.toHaveProperty('attemptsLeft')
    expect(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin', attemptsLeft: -1 } })).not.toHaveProperty('attemptsLeft')
    expect(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'pin', attemptsLeft: 1.5 } })).not.toHaveProperty('attemptsLeft')
  })

  it('passes on only the safe parts of the details', () => {
    expect(toActionFailure({ code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-01', actorMemberId: 'secret', note: 42 } })).toEqual({ ok: false, code: 'SOD_VIOLATION', rule: 'BR-SOD-01' })
  })
})

describe('[FR-INT-009/AC2] [FR-INT-009/AC1] the requester’s actions explain every refusal', () => {
  it.each([
    [{ code: 'INVALID_STATE_TRANSITION', details: { from: 'APPROVED' } }, 'STATE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'reason' } }, 'REASON'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'answer' } }, 'ANSWER'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'budgetLineId', reason: 'CHOOSE_BUDGET_LINE' } }, 'BUDGET_LINE'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'formData.scopeOfWork', reason: 'FORM' } }, 'FORM'],
    [{ code: 'VALIDATION_FAILED', details: { field: 'lines.0.serviceEndDate', reason: 'SERVICE_END_DATE' } }, 'FORM'],
    [{ code: 'ATTACHMENT_RULE_FAILED', details: { rule: 'ATT-QUOTES' } }, 'ATTACHMENT'],
    [{ code: 'BUDGET_INSUFFICIENT', details: { available: '25000.00', shortfall: '35000.00' } }, 'BUDGET_INSUFFICIENT'],
    [{ code: 'BUDGET_LINE_CLOSED', details: { status: 'FROZEN' } }, 'BUDGET_LINE_CLOSED'],
    [{ code: 'DOA_NOT_CONFIGURED' }, 'DOA_NOT_CONFIGURED'],
    [{ code: 'TAX_RATE_NOT_CONFIGURED', details: { date: '2026-10-05' } }, 'TAX_RATE'],
    [{ code: 'FORBIDDEN' }, 'FORBIDDEN'],
    [{ code: 'RATE_LIMITED' }, 'BUSY'],
    [{ code: 'TOKEN_USED' }, 'FAILED'],
  ] as const)('%j → %s', (error, key) => {
    expect(requestErrorKey(toActionFailure(error))).toBe(key)
  })

  it('[§9.9] no answer (the connection dropped) is said as no answer, never "not saved": the same button again does it once', () => {
    expect(requestErrorKey(NO_ANSWER)).toBe('NO_ANSWER')
    expect(th.requestView.errors.NO_ANSWER).toBe('ไม่ได้รับคำตอบจากระบบ อาจเป็นเพราะการเชื่อมต่อ ตรวจการเชื่อมต่อแล้วกดปุ่มเดิมอีกครั้ง ระบบทำรายการนี้เพียงครั้งเดียว')
    expect(th.requestView.errors.NO_ANSWER).not.toContain('ไม่สำเร็จ')
    expect(en.requestView.errors.NO_ANSWER).toBe('No answer came back, perhaps because of the connection. Check it and press the same button again; it is done only once.')
    // An answer the screen does not know is still "not saved"
    expect(requestErrorKey(toActionFailure({ code: 'SOMETHING_NEW' }))).toBe('FAILED')
  })

  it('keeps the budget amounts as decimal text for the message', () => {
    expect(toActionFailure({ code: 'BUDGET_INSUFFICIENT', details: { available: '25000.00', shortfall: '35000.00' } })).toEqual({ ok: false, code: 'BUDGET_INSUFFICIENT', available: '25000.00', shortfall: '35000.00' })
  })
})
