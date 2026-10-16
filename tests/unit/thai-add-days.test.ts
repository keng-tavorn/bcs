import { describe, expect, it } from 'vitest'
import { addDays } from '@/core/thai/day'

// addDays (S9-02 review): the window of a recent bank change (BR-PAY-06 · BR-SOD-10) counted on real calendar days

describe('addDays', () => {
  it('counts back and forward across months, years and a leap day', () => {
    expect(addDays('2026-10-16', -30)).toBe('2026-09-16')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2026-10-16', 0)).toBe('2026-10-16')
  })

  it('throws on a day that does not exist or a part of a day', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError)
    expect(() => addDays('16/10/2026', 1)).toThrow(RangeError)
    expect(() => addDays('2026-10-16', 1.5)).toThrow(RangeError)
  })
})
