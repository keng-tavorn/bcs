import { describe, expect, it } from 'vitest'
import { errorKey, eventKey, fromBangkokInput, toBangkokInput } from '@/ui/sourcing/rfx-detail/model'

// The pure helpers of the RFx page (S10-12 · /sourcing/[id]): the close typed in Bangkok time goes to the service as ISO
// text with its offset and back, a refusal is named by its reason before its code, and an event type becomes its key.

describe('[FR-SRC-201/AC5] RFx page: the close in Bangkok time', () => {
  it('reads an instant as the input value in Bangkok time', () => {
    expect(toBangkokInput('2026-11-20T10:00:00.000Z')).toBe('2026-11-20T17:00')
    expect(toBangkokInput('2026-11-20T20:30:00.000Z')).toBe('2026-11-21T03:30')
    expect(toBangkokInput(null)).toBe('')
    expect(toBangkokInput('not a date')).toBe('')
  })

  it('writes the input value as ISO text with +07:00, and refuses what is not a real time', () => {
    expect(fromBangkokInput('2026-11-20T17:00')).toBe('2026-11-20T17:00:00+07:00')
    expect(fromBangkokInput('2026-02-31T10:00')).toBeNull()
    expect(fromBangkokInput('2026-11-20')).toBeNull()
    expect(fromBangkokInput('')).toBeNull()
  })

  it('goes there and back unchanged', () => {
    const iso = fromBangkokInput('2026-12-01T09:15')!
    expect(toBangkokInput(new Date(iso).toISOString())).toBe('2026-12-01T09:15')
  })
})

describe('[FR-SRC-201/AC6] RFx page: refusals and events in words', () => {
  it('names a refusal by its reason when the page knows it, else by its code, else OTHER', () => {
    expect(errorKey({ code: 'VALIDATION_FAILED', reason: 'INVITES_WAITING' })).toBe('INVITES_WAITING')
    expect(errorKey({ code: 'INVALID_STATE_TRANSITION', reason: 'AWARD_OPEN' })).toBe('AWARD_OPEN')
    expect(errorKey({ code: 'CONFLICT_VERSION' })).toBe('CONFLICT_VERSION')
    expect(errorKey({ code: 'VALIDATION_FAILED', reason: 'SOMETHING_ELSE' })).toBe('VALIDATION_FAILED')
    expect(errorKey({ code: 'WHATEVER' })).toBe('OTHER')
  })

  it('turns an event type into a message key without a dot', () => {
    expect(eventKey('rfx.opened')).toBe('rfx_opened')
    expect(eventKey('rfx.question_answered')).toBe('rfx_question_answered')
    expect(eventKey('bid.submitted')).toBe('other')
  })
})
