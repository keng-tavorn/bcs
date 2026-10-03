import { TZDate } from '@date-fns/tz'
import { MS_PER_MINUTE, SCHEDULE_LOOK_BACK_MINUTES } from '../money/constants'

// Schedules of an organization written as cron with a time zone, e.g. "TZ=Asia/Bangkok 0 10,15 * * 1-5" (settings
// consolidation.cron, OQ-13): five fields minute hour day-of-month month day-of-week, each `*`, a number, a range a-b,
// a list and a step `/n`; day of week 0 or 7 is Sunday. As in classic cron, when both day fields are restricted a day
// matching either is due. Pure: the caller gives the instants.

export interface Cron {
  readonly timeZone: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  readonly anyDayOfMonth: boolean
  readonly anyDayOfWeek: boolean
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const

function field(text: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return null
    const from = m[1] === '*' ? min : Number(m[2])
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from
    const step = m[4] !== undefined ? Number(m[4]) : 1
    if (from < min || to > max || from > to || step < 1) return null
    for (let v = from; v <= to; v += step) out.add(v)
  }
  return out
}

/** "TZ=Asia/Bangkok 0 10,15 * * 1-5" → the cron, or null when it is not one this reader accepts */
export function parseCron(expression: string): Cron | null {
  const m = /^TZ=(\S+)\s+(.+)$/.exec(expression.trim())
  if (!m) return null
  const parts = m[2]!.trim().split(/\s+/)
  if (parts.length !== FIELDS.length) return null
  const sets = parts.map((p, i) => field(p, FIELDS[i]!.min, FIELDS[i]!.max))
  if (sets.some((s) => s === null)) return null
  const [minutes, hours, daysOfMonth, months, dow] = sets as Set<number>[]
  const daysOfWeek = new Set([...dow!].map((d) => d % 7))
  if (!knownTimeZone(m[1]!)) return null
  return { timeZone: m[1]!, minutes: minutes!, hours: hours!, daysOfMonth: daysOfMonth!, months: months!, daysOfWeek, anyDayOfMonth: parts[2] === '*', anyDayOfWeek: parts[4] === '*' }
}

function knownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

function matches(cron: Cron, at: TZDate): boolean {
  if (!cron.minutes.has(at.getMinutes()) || !cron.hours.has(at.getHours()) || !cron.months.has(at.getMonth() + 1)) return false
  const dom = cron.daysOfMonth.has(at.getDate())
  const dow = cron.daysOfWeek.has(at.getDay())
  if (cron.anyDayOfMonth || cron.anyDayOfWeek) return dom && dow
  return dom || dow
}

/**
 * The latest instant at or before `at`, and after `after`, that the cron names (whole minutes), or null. Looks back
 * at most `lookBackMinutes` (a day by default) so a schedule missed while the system was down runs once, not for
 * every missed slot.
 */
export function latestSlot(cron: Cron, at: Date, after: Date | null = null, lookBackMinutes = SCHEDULE_LOOK_BACK_MINUTES): Date | null {
  const start = Math.floor(at.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE
  for (let i = 0; i <= lookBackMinutes; i++) {
    const t = start - i * MS_PER_MINUTE
    if (after && t <= after.getTime()) return null
    if (matches(cron, new TZDate(t, cron.timeZone))) return new Date(t)
  }
  return null
}

/** The calendar day (YYYY-MM-DD) of an instant in the cron's time zone */
export function localDay(cron: Cron, at: Date): string {
  const d = new TZDate(at.getTime(), cron.timeZone)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
