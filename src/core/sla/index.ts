import { TZDate } from '@date-fns/tz'
import { MAX_CALENDAR_SEARCH_DAYS, MS_PER_MINUTE } from '../money/constants'

// Business time and SLA (spec §7.8, BR-SLA-01 to BR-SLA-03). Business hours come from settings.businessCalendar
// (default Mon–Fri 08:30–17:30 Asia/Bangkok, no lunch break, A-07) together with the Holiday table. Pure: callers
// pass the instants and the calendar; nothing here reads the clock.

export const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface BusinessCalendar {
  readonly timezone: string
  readonly workdays: readonly Weekday[]
  /** "HH:mm" local time */
  readonly start: string
  /** "HH:mm" local time, after start */
  readonly end: string
  /** Local dates "YYYY-MM-DD" */
  readonly holidays: readonly string[]
}


function minutesOfDay(hhmm: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm)
  if (!m) throw new RangeError(`invalid time of day: ${hhmm}`)
  return Number(m[1]) * 60 + Number(m[2])
}

interface Day {
  /** Local midnight of the day */
  readonly midnight: TZDate
  readonly key: string
  readonly weekday: Weekday
}

function dayOf(instant: Date, timezone: string): Day {
  const local = new TZDate(instant.getTime(), timezone)
  const midnight = new TZDate(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, timezone)
  return { midnight, key: keyOf(midnight), weekday: WEEKDAYS[midnight.getDay()]! }
}

function keyOf(local: TZDate): string {
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

function nextDay(day: Day, timezone: string): Day {
  return shiftDay(day, 1, timezone)
}

function shiftDay(day: Day, by: 1 | -1, timezone: string): Day {
  const m = day.midnight
  const next = new TZDate(m.getFullYear(), m.getMonth(), m.getDate() + by, 0, 0, timezone)
  return { midnight: next, key: keyOf(next), weekday: WEEKDAYS[next.getDay()]! }
}

interface Window {
  readonly from: number
  readonly to: number
}

/** Business window of the day in epoch ms, or null when the day is not a business day. */
function windowOf(day: Day, calendar: BusinessCalendar, startMin: number, endMin: number): Window | null {
  if (!calendar.workdays.includes(day.weekday) || calendar.holidays.includes(day.key)) return null
  const m = day.midnight
  const at = (minutes: number) => new TZDate(m.getFullYear(), m.getMonth(), m.getDate(), Math.floor(minutes / 60), minutes % 60, calendar.timezone).getTime()
  return { from: at(startMin), to: at(endMin) }
}

function checked(calendar: BusinessCalendar): { startMin: number; endMin: number } {
  const startMin = minutesOfDay(calendar.start)
  const endMin = minutesOfDay(calendar.end)
  if (endMin <= startMin) throw new RangeError('business hours must end after they start')
  if (calendar.workdays.length === 0) throw new RangeError('the calendar has no business days')
  return { startMin, endMin }
}

/** BR-SLA-02: the instant `minutes` business minutes after `from` (a start outside hours begins at the next opening). */
export function addBusinessMinutes(from: Date, minutes: number, calendar: BusinessCalendar): Date {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`minutes must be a whole number ≥ 0: ${minutes}`)
  const { startMin, endMin } = checked(calendar)
  let remaining = minutes * MS_PER_MINUTE
  let cursor = from.getTime()
  let day = dayOf(from, calendar.timezone)
  for (let i = 0; i < MAX_CALENDAR_SEARCH_DAYS; i++) {
    const window = windowOf(day, calendar, startMin, endMin)
    if (window && cursor < window.to) {
      const begin = Math.max(cursor, window.from)
      const available = window.to - begin
      if (remaining <= available) return new Date(begin + remaining)
      remaining -= available
    }
    day = nextDay(day, calendar.timezone)
    cursor = day.midnight.getTime()
  }
  throw new RangeError('no business time found within ten years')
}

/**
 * The instant `minutes` business minutes before `to` — the latest one with exactly that much business time up to `to`
 * (an end outside hours counts back from the last closing before it). It dates work that has waited a known time,
 * such as the pending requests of the demo history (D-01); 0 minutes is `to` itself.
 */
export function subtractBusinessMinutes(to: Date, minutes: number, calendar: BusinessCalendar): Date {
  if (!Number.isInteger(minutes) || minutes < 0) throw new RangeError(`minutes must be a whole number ≥ 0: ${minutes}`)
  const { startMin, endMin } = checked(calendar)
  if (minutes === 0) return new Date(to.getTime())
  let remaining = minutes * MS_PER_MINUTE
  let cursor = to.getTime()
  let day = dayOf(to, calendar.timezone)
  for (let i = 0; i < MAX_CALENDAR_SEARCH_DAYS; i++) {
    const window = windowOf(day, calendar, startMin, endMin)
    if (window && cursor > window.from) {
      const finish = Math.min(cursor, window.to)
      const available = finish - window.from
      if (remaining <= available) return new Date(finish - remaining)
      remaining -= available
    }
    day = shiftDay(day, -1, calendar.timezone)
    cursor = Number.POSITIVE_INFINITY
  }
  throw new RangeError('no business time found within ten years')
}

/** Business minutes in [from, to) (GC-SLA-05); 0 when `to` is not after `from`. */
export function businessMinutesBetween(from: Date, to: Date, calendar: BusinessCalendar): number {
  const { startMin, endMin } = checked(calendar)
  const end = to.getTime()
  let total = 0
  let day = dayOf(from, calendar.timezone)
  let cursor = from.getTime()
  for (let i = 0; cursor < end; i++) {
    if (i >= MAX_CALENDAR_SEARCH_DAYS) throw new RangeError('period longer than ten years')
    const window = windowOf(day, calendar, startMin, endMin)
    if (window) total += Math.max(0, Math.min(window.to, end) - Math.max(window.from, cursor))
    day = nextDay(day, calendar.timezone)
    cursor = day.midnight.getTime()
  }
  return Math.floor(total / MS_PER_MINUTE)
}

/** BR-SLA-03: after an info request, the due time is the remaining SLA counted from when the answer came. */
export function resumeDue(input: { assignedAt: Date; slaMinutes: number; pausedAt: Date; resumedAt: Date }, calendar: BusinessCalendar): Date {
  const used = businessMinutesBetween(input.assignedAt, input.pausedAt, calendar)
  return addBusinessMinutes(input.resumedAt, Math.max(0, input.slaMinutes - used), calendar)
}

/** BR-SLA-02: reminder when `remindPct` percent of the SLA has passed (whole minutes, half up). */
export function remindAt(input: { assignedAt: Date; slaMinutes: number; remindPct: number }, calendar: BusinessCalendar): Date {
  const minutes = Math.floor((input.slaMinutes * input.remindPct + 50) / 100)
  return addBusinessMinutes(input.assignedAt, minutes, calendar)
}
