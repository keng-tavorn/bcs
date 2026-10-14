import { formatEnglishBeDateTime, formatThaiDateTime } from '@/core/thai/date'

/** A date and time as each language shows it (FR-PLT-002 AC3): "2 ต.ค. 2569 16:30 น." · "2 Oct 2569 16:30". */
export function formatDateTime(locale: string, input: Date | string): string {
  return locale === 'en' ? formatEnglishBeDateTime(input) : formatThaiDateTime(input)
}

/**
 * Basis points as a percent with two decimals, by integer arithmetic only (S6-11 · BR-PRC-03): 1250 → "+12.50%",
 * -305 → "-3.05%", 0 → "0.00%", 123456 → "+1,234.56%". Without `signed` a positive number has no "+" (a threshold:
 * "10.00%"); a negative one keeps its "-". Basis points are a whole number from the core (deviationBp, alertBp), never money.
 */
export function formatBpPercent(bp: number, { signed = true }: { signed?: boolean } = {}): string {
  if (!Number.isSafeInteger(bp)) throw new RangeError(`basis points must be a whole number: ${bp}`)
  const abs = Math.abs(bp)
  const hundredths = abs % 100
  const whole = (abs - hundredths) / 100
  const sign = bp < 0 ? '-' : bp > 0 && signed ? '+' : ''
  return `${sign}${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(hundredths).padStart(2, '0')}%`
}
