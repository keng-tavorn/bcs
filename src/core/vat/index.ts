import { TZDate } from '@date-fns/tz'

// VAT rate lookup (spec §7.1, BR-VAT-01): the rate comes from the TaxRate table by the tax date in Thai time, never
// from a number in code. No period covering the date → TAX_RATE_NOT_CONFIGURED, which blocks the document loudly.

export const TAX_TIME_ZONE = 'Asia/Bangkok'

export interface TaxRateSnapshot {
  readonly code: string
  readonly rateBp: number
  /** "YYYY-MM-DD", first day */
  readonly effectiveFrom: string
  /** "YYYY-MM-DD", last day inclusive; null = open-ended */
  readonly effectiveTo: string | null
}

/** The tax date of an instant: its calendar date in Thai time (GC-VAT-04: 17:00Z is midnight of the next day). */
export function taxDateOf(at: Date): string {
  const local = new TZDate(at.getTime(), TAX_TIME_ZONE)
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export type RateLookup = { readonly ok: true; readonly rateBp: number } | { readonly ok: false; readonly error: 'TAX_RATE_NOT_CONFIGURED'; readonly date: string }

/** The rate whose period covers the date ("YYYY-MM-DD" strings compare in date order). */
export function rateFor(date: string, rates: readonly TaxRateSnapshot[], code = 'VAT_STANDARD'): RateLookup {
  if (!DATE.test(date)) throw new RangeError(`invalid tax date: ${date}`)
  const found = rates.find((r) => r.code === code && r.effectiveFrom <= date && (r.effectiveTo === null || date <= r.effectiveTo))
  return found ? { ok: true, rateBp: found.rateBp } : { ok: false, error: 'TAX_RATE_NOT_CONFIGURED', date }
}
