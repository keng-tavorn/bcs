import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { documentTotals, lineNetsBeforeVat } from '@/core/money/math'

// BR-BUD-03 and BR-BUD-05 (ADR-038 ข้อ 11): the amount before VAT of each line, which the budget reserves. With prices
// that include VAT the document's VAT comes off the VAT-able lines only, by largest remainder, and the lines always add
// up to the document's amount before VAT.

describe('[FR-INT-007/AC1] the budget reserves each line before VAT', () => {
  it('keeps line amounts when prices are before VAT', () => {
    expect(lineNetsBeforeVat([{ quantity: '2', unitPriceSatang: 150n }, { quantity: '1.5', unitPriceSatang: 1001n }], 700)).toEqual([300n, 1502n])
  })

  it('takes the VAT off the VAT-able lines only, and gives the odd satang to the largest remainder', () => {
    // 107.00 + 53.50 with VAT included and a 10.00 line without VAT: VAT 10.50 off the first two only
    const nets = lineNetsBeforeVat([{ quantity: '1', unitPriceSatang: 10_700n }, { quantity: '1', unitPriceSatang: 5_350n }, { quantity: '1', unitPriceSatang: 1_000n, vatable: false }], 700, true)
    expect(nets).toEqual([10_000n, 5_000n, 1_000n])
    // Three equal lines of 1.00 including VAT: net 2.80 shared 0.94, 0.93, 0.93
    expect(lineNetsBeforeVat([1, 2, 3].map(() => ({ quantity: '1', unitPriceSatang: 100n })), 700, true)).toEqual([94n, 93n, 93n])
    // Nothing VAT-able: every line keeps its amount
    expect(lineNetsBeforeVat([{ quantity: '1', unitPriceSatang: 500n, vatable: false }], 700, true)).toEqual([500n])
  })

  it('adds up to the document amount before VAT for any lines (1,000 random documents)', () => {
    const line = fc.record({ quantity: fc.integer({ min: 1, max: 9999 }).map(String), unitPriceSatang: fc.bigInt({ min: 0n, max: 100_000_000n }), vatable: fc.boolean() })
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 8 }), fc.boolean(), (lines, includesVat) => {
        const nets = lineNetsBeforeVat(lines, 700, includesVat)
        expect(nets.reduce((a, b) => a + b, 0n)).toBe(documentTotals(lines, 700, includesVat).net)
        for (const n of nets) expect(n >= 0n).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })
})
