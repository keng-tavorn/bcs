import { describe, expect, it } from 'vitest'
import { remindErrorKey, scheduleErrorKey, toInsightFailure } from '@/ui/insight/outcome'

// What the board's reminder and the report schedule say when the service refuses (spec §9.9 rule 7, §14.2): the cause in
// plain words, never a wrong one. RATE_LIMITED is the once-an-hour rule only when the service says so; runCommand also
// answers RATE_LIMITED when the database is busy, which must not read as "someone reminded it already".

describe('[FR-VIS-001/AC2] a refused reminder says why: within the hour, the database busy, or read only', () => {
  it('maps each refusal of remindTask to its words', () => {
    const recent = toInsightFailure({ code: 'RATE_LIMITED', details: { reason: 'REMINDED_WITHIN_HOUR', nextAt: '2026-10-05T07:00:00.000Z' } })
    expect(recent).toEqual({ ok: false, code: 'RATE_LIMITED', reason: 'REMINDED_WITHIN_HOUR', nextAt: '2026-10-05T07:00:00.000Z' })
    expect(remindErrorKey(recent)).toBe('RECENT')
    // runCommand gave up waiting for a lock: no time to quote, and not the hour's rule
    const busy = toInsightFailure({ code: 'RATE_LIMITED', details: { requestId: 'req-1' } })
    expect(remindErrorKey(busy)).toBe('BUSY')
    // BR-AUTH-04: the auditor reads only
    expect(remindErrorKey(toInsightFailure({ code: 'FORBIDDEN', details: { capability: 'board.pending.view', reason: 'READ_ONLY' } }))).toBe('READ_ONLY')
    expect(remindErrorKey(toInsightFailure({ code: 'FORBIDDEN', details: { capability: 'board.pending.view' } }))).toBe('FORBIDDEN')
    expect(remindErrorKey(toInsightFailure({ code: 'INVALID_STATE_TRANSITION' }))).toBe('STATE')
    expect(remindErrorKey(toInsightFailure({ code: 'NOT_FOUND' }))).toBe('NOT_FOUND')
    expect(remindErrorKey(toInsightFailure({ code: 'IDEMPOTENCY_CONFLICT' }))).toBe('CONFLICT')
  })
})

describe('[FR-VIS-002/AC3] a schedule refused for a recipient who may not read the report says so', () => {
  it('tells "no recipient" from "a recipient who may not read it", and a busy database from a failure', () => {
    expect(scheduleErrorKey(toInsightFailure({ code: 'VALIDATION_FAILED', details: { field: 'recipientMemberIds', reason: 'RECIPIENT_SCOPE', count: 1 } }))).toBe('RECIPIENT_SCOPE')
    expect(scheduleErrorKey(toInsightFailure({ code: 'VALIDATION_FAILED', details: { field: 'recipientMemberIds', reason: 'RECIPIENT' } }))).toBe('RECIPIENTS')
    expect(scheduleErrorKey({ ok: false, code: 'VALIDATION_FAILED', field: 'recipientMemberIds' })).toBe('RECIPIENTS')
    expect(scheduleErrorKey(toInsightFailure({ code: 'RATE_LIMITED', details: { requestId: 'req-2' } }))).toBe('BUSY')
  })
})
