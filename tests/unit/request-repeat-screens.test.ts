import { describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import th from '../../messages/th.json'
import { canRenew, canReorder, RENEWABLE_STATUSES, repeatErrorKey } from '@/ui/request-view/repeat-rules'
import { toActionFailure } from '@/ui/tasks/outcome'

// S6-12 on screen (FR-INT-101): when the request page shows "ขอซ้ำ" and "สร้างคำขอต่ออายุ", and the words of a refusal.
// The buttons are the requester's only; the service checks the requester, the state and the line again
// (tests/integration/reorder.test.ts).

const ALL_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED', 'REJECTED', 'CANCELLED', 'SUBMITTED', 'DONE']

describe('[FR-INT-101/AC1] "ขอซ้ำ" is the requester\'s, on a request sent at least once', () => {
  it('shows for the requester in every status but DRAFT (a draft is edited, not reordered)', () => {
    for (const status of ALL_STATUSES) expect(canReorder(true, status), status).toBe(status !== 'DRAFT')
  })

  it('never shows for anyone else (a follower, a department head, PROCUREMENT)', () => {
    for (const status of ALL_STATUSES) expect(canReorder(false, status), status).toBe(false)
  })

  it('says why a reorder is refused: the type is no longer offered, a draft, not the requester, no answer', () => {
    expect(repeatErrorKey(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'requestTypeCode', reason: 'TYPE_INACTIVE' } }))).toBe('TYPE_INACTIVE')
    expect(repeatErrorKey(toActionFailure({ code: 'INVALID_STATE_TRANSITION', details: { from: 'DRAFT' } }))).toBe('STATE')
    expect(repeatErrorKey(toActionFailure({ code: 'FORBIDDEN' }))).toBe('FORBIDDEN')
    expect(repeatErrorKey(toActionFailure({ code: 'NOT_FOUND' }))).toBe('NOT_FOUND')
    expect(repeatErrorKey({ ok: false, code: 'NO_ANSWER' })).toBe('NO_ANSWER')
    expect(th.requestView.errors.TYPE_INACTIVE).toContain('ขอซื้อ / ขอจ้าง')
    expect(en.requestView.errors.TYPE_INACTIVE).toContain('Buy or hire')
  })
})

describe('[FR-INT-101/AC2] "สร้างคำขอต่ออายุ" is on the service lines of the requester\'s request once ordered or done', () => {
  it('shows for the requester when the request is ordered in part, ordered or completed — the statuses the reminder names', () => {
    expect(RENEWABLE_STATUSES).toEqual(['PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED'])
    for (const status of ALL_STATUSES) expect(canRenew(true, status), status).toBe(['PARTIALLY_ORDERED', 'ORDERED', 'COMPLETED'].includes(status))
  })

  it('never shows for anyone else', () => {
    for (const status of ALL_STATUSES) expect(canRenew(false, status), status).toBe(false)
  })

  it('says why a renewal is refused: the line is not a service line', () => {
    expect(repeatErrorKey(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'requestLineId', reason: 'NOT_A_SERVICE_LINE' } }))).toBe('NOT_A_SERVICE_LINE')
    // Any other refused field of the draft is the requester actions' (the form's words)
    expect(repeatErrorKey(toActionFailure({ code: 'VALIDATION_FAILED', details: { field: 'lines.0.quantity' } }))).toBe('FORM')
  })

  it('has the words of both buttons and both refusals in Thai and English', () => {
    for (const messages of [th, en]) {
      for (const key of ['reorder', 'reorderTitle', 'reorderHint', 'repeatWorking', 'renewTitle', 'renewHint', 'renewList', 'renew', 'renewLabel'] as const) expect(messages.requestView.actions[key], key).toEqual(expect.any(String))
      for (const key of ['TYPE_INACTIVE', 'NOT_A_SERVICE_LINE'] as const) expect(messages.requestView.errors[key], key).toEqual(expect.any(String))
    }
    expect(th.requestView.actions.reorder).toBe('ขอซ้ำ')
    expect(th.requestView.actions.renew).toBe('สร้างคำขอต่ออายุ')
  })
})
