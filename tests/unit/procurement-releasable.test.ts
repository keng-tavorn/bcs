import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { lineNet, lineNetsBeforeVat, parseQuantity } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { releasableFor } from '@/server/services/procurement/pool'

// BR-BUD-05 (spec §7.7): what a PO gives back to the request line it orders when the PO is approved. A request priced
// before VAT gives back the quantity ordered × the request's unit price, rounded half up once — the amount of a line,
// BR-MONEY-02 (1). Never a share of the line's amount: that amount was rounded already, and sharing it rounds a second
// time, which BR-MONEY-02 does not allow. The share by quantity is ADR-038 item 11's rule for a request whose prices
// include VAT, which has no unit price before VAT (and reaches no PO until NEW-50 is decided).

/** A request line as the pool reads it: quantity × unit price, its amount before VAT from core */
function requestLine(quantity: string, unitPriceSatang: bigint, priceIncludesVat = false) {
  const [netBeforeVat] = lineNetsBeforeVat([{ quantity, unitPriceSatang }], 700, priceIncludesVat)
  return { quantity: parseQuantity(quantity), unitPriceSatang, priceIncludesVat, netBeforeVat: netBeforeVat! }
}

describe('[FR-P2P-004/AC2] what a PO gives back to its request line is rounded once (BR-BUD-05, BR-MONEY-02)', () => {
  it('gives back the quantity ordered × the request unit price, not a share of the rounded line amount', () => {
    // 2.5 × 10.01 = 25.025 → 25.03 (GC-MONEY-07)
    const line = requestLine('2.5', 1_001n)
    expect(line.netBeforeVat).toBe(2_503n)
    // 2.4 × 10.01 = 24.024 → 24.02; a share would be 25.03 × 2.4 ÷ 2.5 = 24.0288 → 24.03
    expect(releasableFor(line, parseQuantity('2.4'))).toBe(2_402n)
    // 1.4 × 10.01 = 14.014 → 14.01; a share would be 25.03 × 1.4 ÷ 2.5 = 14.0168 → 14.02
    expect(releasableFor(line, parseQuantity('1.4'))).toBe(1_401n)
    // the whole line gives back the amount it reserved
    expect(releasableFor(line, parseQuantity('2.5'))).toBe(2_503n)
  })

  it('shares the amount before VAT by quantity only for a request whose prices include VAT (ADR-038 item 11)', () => {
    // 3 × 100.00 including VAT 7%: 280.37 before VAT; 1 of 3 gives back 280.37 × 1 ÷ 3 = 93.4567 → 93.46
    const line = requestLine('3', 10_000n, true)
    expect(line.netBeforeVat).toBe(28_037n)
    expect(releasableFor(line, parseQuantity('1'))).toBe(9_346n)
    expect(releasableFor(line, parseQuantity('3'))).toBe(28_037n)
  })

  it('a PO line at the request price needs exactly what it gives back, so nothing is reserved or freed for it (1,000 random lines)', () => {
    // up to 9,999.9999 units at up to 1,000,000.00; any part of the line
    const part = fc.record({ quantity: fc.bigInt({ min: 1n, max: 99_999_999n }), unitPriceSatang: fc.bigInt({ min: 0n, max: 100_000_000n }), share: fc.bigInt({ min: 1n, max: 10_000n }) })
    fc.assert(
      fc.property(part, ({ quantity, unitPriceSatang, share }) => {
        const line = requestLine(formatQuantity(quantity), unitPriceSatang)
        const ordered = (quantity * share) / 10_000n || 1n
        // how a draft and an edited PO line are priced: quantity × the request unit price (consolidate.ts, editDraftPo)
        expect(releasableFor(line, ordered)).toBe(lineNet(formatQuantity(ordered), unitPriceSatang))
      }),
      { numRuns: 1000 },
    )
  })
})
