import { MS_PER_DAY, PERCENT_TENTHS_SCALE } from '@/lib/constants'

// Numbers of the insight screens (spec §11.1, §11.4): business hours with one decimal and shares with one decimal,
// rounded half up in integers — counts and minutes only, never money.

const MINUTES_PER_HOUR = 60

/** Business minutes as hours with one decimal, e.g. 1,083 minutes → "18.1" */
export function hoursText(minutes: number): string {
  const tenths = Math.floor((minutes * 10 * 2 + MINUTES_PER_HOUR) / (2 * MINUTES_PER_HOUR))
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}

/** numerator ÷ denominator in percent with one decimal ("60.0"), or null when nothing was counted */
export function percentText(numerator: number, denominator: number | null): string | null {
  if (denominator === null || denominator <= 0) return null
  const tenths = Math.floor((numerator * Number(PERCENT_TENTHS_SCALE) * 2 + denominator) / (2 * denominator))
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}

/** The calendar day "YYYY-MM-DD" of an instant in a time zone */
export function dayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** The calendar day `days` before a day "YYYY-MM-DD" (calendar arithmetic, no time zone involved) */
export function daysBefore(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const at = new Date(Date.UTC(y, m - 1, d - days))
  return at.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`, both counted ("2026-10-01" to "2026-10-01" is 1) */
export function daysInPeriod(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / MS_PER_DAY) + 1
}
