import { TZDate } from '@date-fns/tz'
import { THAI_TIME_ZONE } from '@/core/thai/date'

// The proposal form takes times with datetime-local inputs ("YYYY-MM-DDTHH:mm"), read as Thai time, the time every
// screen shows. The form echoes the chosen time back in Buddhist-era Thai (the browser's own picker follows the
// browser's calendar), and the server action turns the same text into an instant with this same function.

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** A datetime-local value read as Thai time, as an ISO instant; null when it is not a real date and time. */
export function thaiLocalToIso(local: string): string | null {
  const m = LOCAL.exec(local.trim())
  if (!m) return null
  const [year, month, day, hour, minute] = m.slice(1).map(Number) as [number, number, number, number, number]
  const at = new TZDate(year, month - 1, day, hour, minute, 0, THAI_TIME_ZONE)
  if (Number.isNaN(at.getTime())) return null
  // A day or time that does not exist (31 April, 25:00) rolls over in Date: refuse it rather than move it
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) return null
  return new Date(at.getTime()).toISOString()
}
