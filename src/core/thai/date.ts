import { TZDate } from '@date-fns/tz'

// Thai dates (BR-DATE-01): store UTC, show Thai time (Asia/Bangkok) with the Buddhist-era year (= CE + 543).
// Short form "2 ต.ค. 2569", time "16:30 น.". Pure: callers pass the instant to format.

export const THAI_TIME_ZONE = 'Asia/Bangkok'
const BE_OFFSET = 543
const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'] as const
const ENGLISH_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

export type DateInput = Date | string

function inThaiTime(input: DateInput): TZDate {
  const instant = typeof input === 'string' ? new Date(input) : input
  if (Number.isNaN(instant.getTime())) throw new RangeError(`invalid date: ${String(input)}`)
  return new TZDate(instant.getTime(), THAI_TIME_ZONE)
}

const twoDigits = (n: number) => String(n).padStart(2, '0')

/** Buddhist-era year of the instant in Thai time (GC-DATE-01, GC-DATE-02). */
export function buddhistYear(input: DateInput): number {
  return inThaiTime(input).getFullYear() + BE_OFFSET
}

/** "2 ต.ค. 2569" (GC-DATE-03) */
export function formatThaiDate(input: DateInput): string {
  const d = inThaiTime(input)
  return `${d.getDate()} ${THAI_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() + BE_OFFSET}`
}

/** "2 ต.ค. 2569 16:30 น." (GC-DATE-04) */
export function formatThaiDateTime(input: DateInput): string {
  const d = inThaiTime(input)
  return `${formatThaiDate(input)} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())} น.`
}

/** English screens keep the Buddhist-era year too (FR-PLT-002 AC3): "2 Oct 2569". */
export function formatEnglishBeDate(input: DateInput): string {
  const d = inThaiTime(input)
  return `${d.getDate()} ${ENGLISH_MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() + BE_OFFSET}`
}

/** "2 Oct 2569 16:30" */
export function formatEnglishBeDateTime(input: DateInput): string {
  const d = inThaiTime(input)
  return `${formatEnglishBeDate(input)} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}`
}
