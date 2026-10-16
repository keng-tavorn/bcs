// A calendar day — "2027-10-31", as a date picker gives it — in words with its Buddhist-era year (BR-DATE-01,
// FR-PLT-002 AC3): "31 ต.ค. 2570" in Thai, "31 Oct 2570" in English, the same words as formatThaiDate and
// formatEnglishBeDate (./date.ts) write for that day. Those turn an instant into Thai time with a time-zone library; a
// day with no time of day needs none, so this one is small enough for the first screen of a LIFF page (§9.4: at most
// 200 KB gzip of first JavaScript with the LINE SDK) and gives the same words on the server and in any phone, whatever
// its ICU data. tests/unit/liff-requests.test.tsx checks the two agree on every day of several centuries. With the same
// month names, the parts a form picks a day by — day, month, Buddhist-era year (src/ui/form/date-field.tsx). Pure.

const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'] as const
const ENGLISH_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** Buddhist era = common era + 543 */
export const BE_OFFSET = 543
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The short names of the twelve months, January first, as the days are written: "ม.ค." … "ธ.ค.", "Jan" … "Dec" */
export function monthNamesShort(locale: 'th' | 'en'): readonly string[] {
  return locale === 'en' ? ENGLISH_MONTHS_SHORT : THAI_MONTHS_SHORT
}

/** The number of days of a month (1–12) of a year of the common era: 28 to 31 */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one; setUTCFullYear keeps years below 100 as they are
  const last = new Date(0)
  last.setUTCFullYear(year, month, 0)
  return last.getUTCDate()
}

/** "2027-10-31" from the year of the common era, the month (1–12) and the day: the form a date picker sends */
export function isoDay(year: number, month: number, date: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`
}

/** The year, month (1–12) and day of a real calendar day; null for anything else ("2027-04-31" included) */
export function partsOf(day: string): { readonly year: number; readonly month: number; readonly date: number } | null {
  const m = DAY.exec(day)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const date = Number(m[3])
  // setUTCFullYear keeps years below 100 as they are
  const check = new Date(0)
  check.setUTCFullYear(year, month - 1, date)
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === date ? { year, month, date } : null
}

/** "2027-10-31" → "31 ต.ค. 2570"; null when it is not a real day */
export function formatThaiDay(day: string): string | null {
  const p = partsOf(day)
  return p ? `${p.date} ${THAI_MONTHS_SHORT[p.month - 1]} ${p.year + BE_OFFSET}` : null
}

/** "2027-10-31" → "31 Oct 2570" (English screens keep the Buddhist-era year); null when it is not a real day */
export function formatEnglishBeDay(day: string): string | null {
  const p = partsOf(day)
  return p ? `${p.date} ${ENGLISH_MONTHS_SHORT[p.month - 1]} ${p.year + BE_OFFSET}` : null
}

/** The day `n` days after a real calendar day (n may be negative): "2026-10-16", −30 → "2026-09-16"; anything else throws */
export function addDays(day: string, n: number): string {
  const p = partsOf(day)
  if (!p || !Number.isInteger(n)) throw new RangeError(`not a calendar day or a whole number of days: ${day} ${n}`)
  const d = new Date(0)
  d.setUTCFullYear(p.year, p.month - 1, p.date + n)
  return isoDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
}
