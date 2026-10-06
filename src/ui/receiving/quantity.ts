import { parseQuantity } from '@/core/money/math'

// Quantities on the receiving screens are decimal text with up to four decimals (PoLine.quantity is Decimal(18,4)):
// never a floating-point number. Typed with thousands separators or spaces, they are cleaned before they are checked.

const QUANTITY = /^\d{1,14}(\.\d{1,4})?$/

/** "1,000.5 " → "1000.5"; anything that is not a quantity of up to four decimals → null */
export function cleanQuantity(typed: string): string | null {
  const text = typed.replace(/[,\s]/g, '')
  return QUANTITY.test(text) ? text : null
}

/** "1000.5" → "1,000.5": thousands separators on the whole part, decimals as they are */
export function groupQuantity(text: string): string {
  const [whole = '0', fraction] = text.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/** Compares two quantities exactly (×10⁴ integers) */
export function compareQuantity(a: string, b: string): number {
  const x = parseQuantity(a)
  const y = parseQuantity(b)
  return x === y ? 0 : x < y ? -1 : 1
}

export const isZeroQuantity = (text: string): boolean => parseQuantity(text) === 0n
