import { describe, expect, it } from 'vitest'
import type { BusinessCalendar } from '@/core/sla'
import { DEFAULT_QUEUE_TARGET_MINUTES, OrgSettingsSchema, queueTargetMinutesOf } from '@/lib/org-settings'
import { countOf, figureOf, onTimeOfQueue, onTimeOfTasks, onTimeWindows, type OnTimeTask } from '@/server/queries/on-time'

// S16-09 · the on-time figures of the home page (spec §11.5, FR-VIS-006 AC3) on data whose answers are known: which
// approval tasks count as on time, late or not at all; the procurement queue against OQ-38's 960 business minutes; the
// percent rounded half up and the change from the 30 days before in whole points, none when there is nothing to compare.

const NOW = new Date('2026-10-10T03:00:00Z')
const { current, previous } = onTimeWindows(NOW)
const at = (iso: string) => new Date(iso)

describe('[FR-VIS-006/AC3] on-time approval tasks of a window (§11.5)', () => {
  it('the window is the last 30 days to now, and the one before it the 30 days before that', () => {
    expect(current).toEqual({ from: at('2026-09-10T03:00:00Z'), to: NOW })
    expect(previous).toEqual({ from: at('2026-08-11T03:00:00Z'), to: at('2026-09-10T03:00:00Z') })
  })

  it('on time when decided by the due time; late when decided after it or still open past it; the rest does not count', () => {
    const due = at('2026-10-01T03:00:00Z')
    const tasks: OnTimeTask[] = [
      { status: 'APPROVED', dueAt: due, decidedAt: at('2026-10-01T03:00:00Z') }, // on time, at the very minute
      { status: 'REJECTED', dueAt: due, decidedAt: at('2026-09-30T03:00:00Z') }, // on time
      { status: 'RETURNED', dueAt: due, decidedAt: at('2026-10-01T03:01:00Z') }, // late
      { status: 'OPEN', dueAt: due, decidedAt: null }, // late: open past its due time
      { status: 'INFO_REQUESTED', dueAt: due, decidedAt: null }, // its SLA stopped
      { status: 'CANCELLED', dueAt: due, decidedAt: null },
      { status: 'REASSIGNED', dueAt: due, decidedAt: null },
      { status: 'APPROVED', dueAt: at('2026-09-01T03:00:00Z'), decidedAt: at('2026-09-01T02:00:00Z') }, // the window before
      { status: 'APPROVED', dueAt: null, decidedAt: at('2026-10-01T02:00:00Z') }, // no due time
    ]
    expect(onTimeOfTasks(tasks, current, NOW)).toEqual({ onTime: 2, late: 2, pct: 50 })
    expect(onTimeOfTasks(tasks, previous, NOW)).toEqual({ onTime: 1, late: 0, pct: 100 })
  })

  it('an open task whose due time is still ahead does not count yet', () => {
    const later = new Date(NOW.getTime() - 1)
    expect(onTimeOfTasks([{ status: 'OPEN', dueAt: later, decidedAt: null }], current, new Date(later.getTime() - 1))).toEqual({ onTime: 0, late: 0, pct: null })
  })

  it('the percent is whole, half up: 2 of 3 is 67%, 1 of 8 is 13%, 1 of 200 is 1%', () => {
    expect(countOf(2, 1).pct).toBe(67)
    expect(countOf(1, 7).pct).toBe(13)
    expect(countOf(1, 199).pct).toBe(1)
    expect(countOf(0, 0).pct).toBeNull()
  })

  it('the change is the exact difference in whole points, half away from zero, and none without tasks in the window before', () => {
    // 80% now against 93.33% before: −13.33 → "ลดลง 13 จุด" (§9.10's example)
    expect(figureOf(countOf(8, 2), countOf(14, 1)).deltaPoints).toBe(-13)
    // 2/3 against 1/2: +16.67 → 17
    expect(figureOf(countOf(2, 1), countOf(1, 1)).deltaPoints).toBe(17)
    // 5/8 against 1/2: +12.5 → 13; 3/8 against 1/2: −12.5 → −13
    expect(figureOf(countOf(5, 3), countOf(1, 1)).deltaPoints).toBe(13)
    expect(figureOf(countOf(3, 5), countOf(1, 1)).deltaPoints).toBe(-13)
    expect(figureOf(countOf(1, 1), countOf(2, 2)).deltaPoints).toBe(0)
    expect(figureOf(countOf(1, 1), countOf(0, 0)).deltaPoints).toBeNull()
    expect(figureOf(countOf(0, 0), countOf(1, 1)).deltaPoints).toBeNull()
  })
})

describe('[FR-VIS-006/AC3] the on-time procurement queue (§11.5, OQ-38)', () => {
  // Monday to Friday, 09:00–17:00 Thai time: 960 business minutes are two working days
  const calendar: BusinessCalendar = { timezone: 'Asia/Bangkok', workdays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], start: '09:00', end: '17:00', holidays: [] }
  // Monday 5 October 10:00 Thai: the target is Wednesday 7 October 10:00 Thai
  const approvedAt = at('2026-10-05T03:00:00Z')
  const deadline = at('2026-10-07T03:00:00Z')

  it('on time when a PO is sent for approval within the target; late after it, or not sent and past it', () => {
    const lines = [
      { approvedAt, submittedAt: deadline, cancelledAt: null }, // on time, at the very minute
      { approvedAt, submittedAt: at('2026-10-06T03:00:00Z'), cancelledAt: null }, // on time
      { approvedAt, submittedAt: new Date(deadline.getTime() + 60_000), cancelledAt: null }, // late
      { approvedAt, submittedAt: null, cancelledAt: null }, // late: not sent and past the target now
      { approvedAt, submittedAt: null, cancelledAt: at('2026-10-06T03:00:00Z') }, // cancelled before the target: not counted
      { approvedAt, submittedAt: null, cancelledAt: at('2026-10-08T03:00:00Z') }, // cancelled after it: late
    ]
    expect(onTimeOfQueue(lines, current, NOW, 960, calendar)).toEqual({ onTime: 2, late: 3, pct: 40 })
  })

  it('a line not sent yet and still within its target does not count', () => {
    const early = at('2026-10-06T03:00:00Z')
    expect(onTimeOfQueue([{ approvedAt, submittedAt: null, cancelledAt: null }], current, early, 960, calendar)).toEqual({ onTime: 0, late: 0, pct: null })
  })

  it('weekends are not business time: approved Friday 16:00, the target is Tuesday 16:00', () => {
    const friday = at('2026-10-09T09:00:00Z')
    const tuesday = at('2026-10-13T09:00:00Z')
    const after = new Date(tuesday.getTime() + 1)
    expect(onTimeOfQueue([{ approvedAt: friday, submittedAt: tuesday, cancelledAt: null }], { from: friday, to: after }, after, 960, calendar)).toMatchObject({ onTime: 1, late: 0 })
    expect(onTimeOfQueue([{ approvedAt: friday, submittedAt: after, cancelledAt: null }], { from: friday, to: after }, after, 960, calendar)).toMatchObject({ onTime: 0, late: 1 })
  })

  it('the target is settings.procurement.queueTargetBusinessMinutes, optional: an organization saved without it reads 960', () => {
    expect(DEFAULT_QUEUE_TARGET_MINUTES).toBe(960)
    expect(queueTargetMinutesOf({})).toBe(960)
    expect(queueTargetMinutesOf(null)).toBe(960)
    expect(queueTargetMinutesOf({ procurement: {} })).toBe(960)
    expect(queueTargetMinutesOf({ procurement: { queueTargetBusinessMinutes: 480 } })).toBe(480)
    expect(OrgSettingsSchema.shape.procurement.safeParse({ queueTargetBusinessMinutes: 0 }).success).toBe(false)
    expect(OrgSettingsSchema.shape.procurement.safeParse({ queueTargetBusinessMinutes: 30.5 }).success).toBe(false)
    expect(OrgSettingsSchema.shape.procurement.safeParse(undefined).success).toBe(true)
  })
})
