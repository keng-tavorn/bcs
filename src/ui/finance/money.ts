import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// Amounts typed on the invoice form (§9.9 rule 6): baht with at most two decimals, typed with or without thousands
// separators. Cleaned before they are checked; added up as BigInt satang, never as floating point.

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/

/** "32,100.5 " → "32100.5"; anything that is not baht with up to two decimals → null */
export function cleanAmount(typed: string): string | null {
  const text = typed.replace(/[,\s]/g, '')
  return AMOUNT.test(text) ? text : null
}

/** "32100.5" → "32,100.50" (for the fields the e-Tax reader fills) */
export function showAmount(amount: string): string {
  const clean = cleanAmount(amount)
  return clean === null ? amount : formatSatang(amountToSatang(clean))
}

/** The sum of two typed amounts, formatted, or null while either is not an amount yet */
export function addAmounts(a: string, b: string): string | null {
  const x = cleanAmount(a)
  const y = cleanAmount(b)
  return x === null || y === null ? null : formatSatang(amountToSatang(x) + amountToSatang(y))
}

/** Two amounts are the same money ("32100.00" and "32,100") */
export function sameAmount(a: string, b: string): boolean {
  const x = cleanAmount(a)
  const y = cleanAmount(b)
  return x !== null && y !== null && amountToSatang(x) === amountToSatang(y)
}

/** A real calendar day as YYYY-MM-DD */
export function isIsoDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const day = new Date(Date.UTC(y, mo - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d
}
