import { TZDate } from '@date-fns/tz'
import { THAI_TIME_ZONE } from '@/core/thai/date'

// The effective date of a DOA draft made on screen (FR-DOA-001 AC1, BR-DOA-12, ADR-042 item 7): a Thai calendar date,
// the version starting at 00:00 Thai time that day. Pure: the caller passes the time.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const twoDigits = (n: number) => String(n).padStart(2, '0')
const dateText = (d: TZDate) => `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`

/** A Thai calendar date as YYYY-MM-DD */
export const THAI_DATE = DATE

/**
 * The dates the editor offers: by default the first day of the next month, and never earlier than tomorrow (no past
 * effective time) nor than the day after a version already approved for later. Both are counted from the later of
 * now and that start.
 */
export function effectiveDates(now: Date, latestPublishedStart: Date | null): { readonly defaultDate: string; readonly minDate: string } {
  const base = latestPublishedStart && latestPublishedStart.getTime() > now.getTime() ? latestPublishedStart : now
  const t = new TZDate(base.getTime(), THAI_TIME_ZONE)
  // Date arithmetic rolls a 13th month into January of the next year and a 32nd day into the next month
  return { defaultDate: dateText(new TZDate(t.getFullYear(), t.getMonth() + 1, 1, THAI_TIME_ZONE)), minDate: dateText(new TZDate(t.getFullYear(), t.getMonth(), t.getDate() + 1, THAI_TIME_ZONE)) }
}

/** "2026-11-01" → 00:00 of that day in Thai time; null when it is not a real calendar date (31 April). */
export function thaiDateStart(date: string): Date | null {
  const m = DATE.exec(date)
  if (!m) return null
  const [year, month, day] = m.slice(1).map(Number) as [number, number, number]
  const at = new TZDate(year, month - 1, day, THAI_TIME_ZONE)
  if (Number.isNaN(at.getTime()) || at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day) return null
  return new Date(at.getTime())
}
