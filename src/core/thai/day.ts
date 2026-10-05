// A calendar day — "2027-10-31", as a date picker gives it — in words with its Buddhist-era year (BR-DATE-01,
// FR-PLT-002 AC3): "31 ต.ค. 2570" in Thai, "31 Oct 2570" in English, the same words as formatThaiDate and
// formatEnglishBeDate (./date.ts) write for that day. Those turn an instant into Thai time with a time-zone library; a
// day with no time of day needs none, so this one is small enough for the first screen of a LIFF page (§9.4: at most
// 200 KB gzip of first JavaScript with the LINE SDK) and gives the same words on the server and in any phone, whatever
// its ICU data. tests/unit/liff-requests.test.tsx checks the two agree on every day of several centuries. Pure.

const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'] as const
const ENGLISH_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
/** Buddhist era = common era + 543 */
const BE_OFFSET = 543
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The year, month (1–12) and day of a real calendar day; null for anything else ("2027-04-31" included) */
function partsOf(day: string): { readonly year: number; readonly month: number; readonly date: number } | null {
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
