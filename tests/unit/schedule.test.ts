import { describe, expect, it } from 'vitest'
import { latestSlot, localDay, parseCron } from '@/core/schedule'

// The consolidation round runs on the organization's cron (FR-P2P-002 AC2, OQ-13 default "TZ=Asia/Bangkok 0 10,15 * * 1-5").

const at = (iso: string) => new Date(iso)

describe('[FR-P2P-002/AC2] organization schedules written as cron with a time zone', () => {
  const cron = parseCron('TZ=Asia/Bangkok 0 10,15 * * 1-5')!

  it('finds the latest round at or before an instant, in Thai time, on weekdays only', () => {
    // Monday 5 Oct 2026, 10:04 in Bangkok = 03:04 UTC → the 10:00 round
    expect(latestSlot(cron, at('2026-10-05T03:04:30Z'))).toEqual(at('2026-10-05T03:00:00Z'))
    // exactly 15:00 → that round
    expect(latestSlot(cron, at('2026-10-05T08:00:00Z'))).toEqual(at('2026-10-05T08:00:00Z'))
    // Monday 09:59 → Friday 15:00 is more than a day back: nothing within the look-back
    expect(latestSlot(cron, at('2026-10-05T02:59:00Z'))).toBeNull()
    expect(latestSlot(cron, at('2026-10-05T02:59:00Z'), null, 4 * 24 * 60)).toEqual(at('2026-10-02T08:00:00Z'))
    // Saturday: nothing that day
    expect(latestSlot(cron, at('2026-10-10T05:00:00Z'), null, 12 * 60)).toBeNull()
  })

  it('skips a round already done', () => {
    expect(latestSlot(cron, at('2026-10-05T03:20:00Z'), at('2026-10-05T03:00:00Z'))).toBeNull()
    expect(latestSlot(cron, at('2026-10-05T08:01:00Z'), at('2026-10-05T03:00:00Z'))).toEqual(at('2026-10-05T08:00:00Z'))
  })

  it('reads steps, ranges, lists, Sunday as 0 or 7, and either day field when both are set', () => {
    const every15 = parseCron('TZ=UTC */15 9-10 * * *')!
    expect(latestSlot(every15, at('2026-10-05T10:59:00Z'))).toEqual(at('2026-10-05T10:45:00Z'))
    const sunday = parseCron('TZ=UTC 0 12 * * 7')!
    expect(latestSlot(sunday, at('2026-10-04T12:30:00Z'))).toEqual(at('2026-10-04T12:00:00Z'))
    // the 1st of the month or a Monday
    const either = parseCron('TZ=UTC 0 0 1 * 1')!
    expect(latestSlot(either, at('2026-10-05T00:10:00Z'))).toEqual(at('2026-10-05T00:00:00Z'))
    expect(latestSlot(either, at('2026-10-01T00:10:00Z'))).toEqual(at('2026-10-01T00:00:00Z'))
    expect(latestSlot(parseCron('TZ=UTC 30 6 15 3 *')!, at('2026-03-15T06:30:00Z'))).toEqual(at('2026-03-15T06:30:00Z'))
    expect(latestSlot(parseCron('TZ=UTC 0 0 * 2 *')!, at('2026-10-05T00:00:00Z'))).toBeNull()
  })

  it('refuses what it cannot read', () => {
    for (const bad of ['0 10 * * 1-5', 'TZ=Asia/Bangkok 0 10 * *', 'TZ=Asia/Bangkok 60 10 * * *', 'TZ=Asia/Bangkok 0 10-9 * * *', 'TZ=Asia/Bangkok */0 10 * * *', 'TZ=Asia/Bangkok a 10 * * *', 'TZ=Not/AZone 0 10 * * *']) {
      expect(parseCron(bad), bad).toBeNull()
    }
  })

  it('names the local day of an instant', () => {
    expect(localDay(cron, at('2026-10-05T17:30:00Z'))).toBe('2026-10-06')
  })
})
