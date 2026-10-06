import { describe, expect, it } from 'vitest'
import { daysBefore, daysInPeriod, hoursText, percentText } from '@/ui/insight/format'

// The numbers the board and the KPI page show (spec §11.1, §11.4): business hours with one decimal, shares with one
// decimal, rounded half up in integers, and the days of a period. (A schedule's cadence is checked with the database in
// tests/integration/insight-screens.test.ts; the KPI page's values next to a baseline in insight-kpi-present.test.ts.)

describe('[FR-VIS-001/AC1] ages on the board are business hours with one decimal, rounded half up', () => {
  it('turns minutes into hours', () => {
    expect(hoursText(0)).toBe('0.0')
    expect(hoursText(1080)).toBe('18.0')
    expect(hoursText(1083)).toBe('18.1')
    // 3 minutes is exactly 0.05 hour: half up
    expect(hoursText(3)).toBe('0.1')
    expect(hoursText(2)).toBe('0.0')
  })
})

describe('[FR-VIS-003/AC1] KPI shares read the same on the screens as in the report file: percent with one decimal, half up', () => {
  it('rounds like the report file (percentText of the report service), and gives none without a denominator', () => {
    expect(percentText(2, 3)).toBe('66.7')
    expect(percentText(1, 3)).toBe('33.3')
    expect(percentText(1, 8)).toBe('12.5')
    expect(percentText(1, 16)).toBe('6.3')
    expect(percentText(3, 3)).toBe('100.0')
    expect(percentText(0, 0)).toBeNull()
    expect(percentText(4, null)).toBeNull()
  })
})

describe('[FR-VIS-003/AC3] the KPI page opens on the 60 days of the review', () => {
  it('counts the days of a period and steps back over month ends', () => {
    expect(daysInPeriod('2026-08-06', '2026-10-04')).toBe(60)
    expect(daysInPeriod('2026-10-04', '2026-10-04')).toBe(1)
    expect(daysBefore('2026-10-04', 59)).toBe('2026-08-06')
    expect(daysBefore('2026-03-01', 1)).toBe('2026-02-28')
    expect(daysBefore('2026-12-31', -1)).toBe('2027-01-01')
  })
})
