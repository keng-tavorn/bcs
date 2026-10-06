// A calendar day of the delegation form (YYYY-MM-DD, a whole day in Thai time) in the words the workspace uses for it
// (src/core/thai/date.ts, BR-DATE-01, FR-PLT-002 AC3): "4 ต.ค. 2569" in Thai, "4 Oct 2569" in English — the Buddhist-era
// year in both. Written with the browser's own Intl and the Buddhist calendar instead of core/thai/date, whose time-zone
// library a LIFF page would otherwise carry in its first JavaScript (§9.4: 200 KB gzip): a day needs no time zone, so it
// is read at UTC midnight. tests/unit/liff-delegation-ui.test.tsx holds it to the workspace's words. Null when the text
// is not a day that exists.

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * The Intl locale that writes the reader's language with the Buddhist-era year. English months come from en-US, whose
 * short September is "Sep" as in the workspace (en-GB writes "Sept"); the parts are put in day-month-year order here.
 */
const intlLocaleOf = (locale: string) => (locale === 'en' ? 'en-US-u-ca-buddhist' : 'th-TH-u-ca-buddhist')

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(locale: string): Intl.DateTimeFormat {
  const key = intlLocaleOf(locale)
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(key, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    formatters.set(key, formatter)
  }
  return formatter
}

export function formatDay(day: string, locale: string): string | null {
  const m = DAY.exec(day)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const instant = new Date(Date.UTC(y, mo - 1, d))
  if (instant.getUTCFullYear() !== y || instant.getUTCMonth() !== mo - 1 || instant.getUTCDate() !== d) return null
  const parts = formatterFor(locale).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('day')} ${part('month')} ${part('year')}`
}
