// Money arithmetic (spec §7.1, BR-MONEY-01, BR-MONEY-02, ADR-018). Whole satang in BigInt; rounding half up (away
// from zero) only at the points BR-MONEY-02 allows: a line amount, document VAT, withholding tax and largest-remainder
// allocation. No floating point anywhere.

import { BP_PER_WHOLE, QUANTITY_SCALE } from './constants'

export { BP_PER_WHOLE }
export type Satang = bigint

const QUANTITY = /^(\d+)(?:\.(\d{1,4}))?$/

/** numerator ÷ denominator rounded half up, away from zero for negatives (denominator > 0). */
export function roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive')
  const n = numerator < 0n ? -numerator : numerator
  const q = (2n * n + denominator) / (2n * denominator)
  return numerator < 0n ? -q : q
}

/** "2.5" → 25000n (×10⁴); refuses negatives, more than 4 decimals and anything else. */
export function parseQuantity(quantity: string): bigint {
  const m = QUANTITY.exec(quantity.trim())
  if (!m) throw new RangeError(`invalid quantity: ${JSON.stringify(quantity)}`)
  return BigInt(m[1]!) * QUANTITY_SCALE + BigInt((m[2] ?? '').padEnd(4, '0'))
}

/** BR-MONEY-02 (1): quantity × unit price, rounded once (GC-MONEY-07: 2.5 × 10.01 = 25.025 → 25.03). */
export function lineNet(quantity: string, unitPriceSatang: Satang): Satang {
  return roundHalfUpDiv(parseQuantity(quantity) * unitPriceSatang, QUANTITY_SCALE)
}

function checkRate(rateBp: number): bigint {
  if (!Number.isInteger(rateBp) || rateBp < 0) throw new RangeError(`invalid VAT rate: ${rateBp} bp`)
  return BigInt(rateBp)
}

/** VAT on a price before VAT (BR-MONEY-02 (2)). */
export function vatFromNet(netSatang: Satang, rateBp: number): { vat: Satang; gross: Satang } {
  const vat = roundHalfUpDiv(netSatang * checkRate(rateBp), BP_PER_WHOLE)
  return { vat, gross: netSatang + vat }
}

/** BR-VAT-03: VAT inside a price that includes it = round(gross × rate ÷ (10000 + rate)); net = gross − VAT. */
export function vatFromGross(grossSatang: Satang, rateBp: number): { vat: Satang; net: Satang } {
  const rate = checkRate(rateBp)
  const vat = roundHalfUpDiv(grossSatang * rate, BP_PER_WHOLE + rate)
  return { vat, net: grossSatang - vat }
}

export interface LineInput {
  readonly quantity: string
  readonly unitPriceSatang: Satang
  /** default true */
  readonly vatable?: boolean
}

/**
 * Document totals (BR-VAT-02, OQ-17): VAT once on the sum of vatable lines. With prices that include VAT, the line
 * amounts are gross and the VAT inside the vatable part is taken out once (GC-MONEY-09).
 */
export function documentTotals(lines: readonly LineInput[], rateBp: number, priceIncludesVat = false): { net: Satang; vat: Satang; gross: Satang } {
  let all = 0n
  let vatable = 0n
  for (const line of lines) {
    const amount = lineNet(line.quantity, line.unitPriceSatang)
    all += amount
    if (line.vatable !== false) vatable += amount
  }
  if (priceIncludesVat) {
    const { vat } = vatFromGross(vatable, rateBp)
    return { net: all - vat, vat, gross: all }
  }
  const { vat } = vatFromNet(vatable, rateBp)
  return { net: all, vat, gross: all + vat }
}

/**
 * BR-MONEY-02 (4): split `total` in proportion to `weights` so the parts add up exactly; leftover satang go to the
 * largest remainders, earlier positions first on a tie. All weights zero → refused unless the total is zero.
 */
export function allocateLargestRemainder(total: Satang, weights: readonly Satang[]): Satang[] {
  if (total < 0n || weights.some((w) => w < 0n)) throw new RangeError('total and weights must not be negative')
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (sum === 0n) {
    if (total === 0n) return weights.map(() => 0n)
    throw new RangeError('cannot allocate a non-zero total over zero weights')
  }
  const parts = weights.map((w) => (total * w) / sum)
  const remainders = weights.map((w, i) => ({ i, r: (total * w) % sum }))
  let left = total - parts.reduce((a, b) => a + b, 0n)
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i))
  for (const { i } of remainders) {
    if (left === 0n) break
    parts[i]! += 1n
    left -= 1n
  }
  return parts
}
