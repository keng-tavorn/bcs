import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { invoiceLineNets, matchInvoice, type MatchPoLine } from '@/core/matching'
import { lineNet } from '@/core/money/math'

// S8-02 (spec §7.14 BR-MATCH-06, BR-MATCH-11): on thousands of random invoices, what a matched invoice moves to ACTUAL
// adds up to its amount before VAT, and the foot discount shared over the lines adds up to the discount.

const policy = { priceTolBp: 100, priceTolSatang: 100_000n, qtyTolBp: 0, vatRateBp: 700 }
const qty = fc.integer({ min: 1, max: 5_000_000 }).map((n) => (n % 10_000 === 0 ? String(n / 10_000) : (n / 10_000).toFixed(4)))
const price = fc.bigInt({ min: 1n, max: 50_000_000n })

const invoiceLines = fc.array(fc.record({ qty, price, budgetLine: fc.constantFrom('BL-A', 'BL-B', 'BL-C'), overBp: fc.integer({ min: 0, max: 150 }) }), { minLength: 1, maxLength: 6 })

describe('[FR-AP-102/AC1] matching properties', () => {
  it('the discount shares add up to the discount and every line net is its amount less its share', () => {
    fc.assert(
      fc.property(invoiceLines, fc.integer({ min: 0, max: 10_000 }), (lines, discountBp) => {
        const amounts = lines.map((l) => lineNet(l.qty, l.price))
        const total = amounts.reduce((a, b) => a + b, 0n)
        const discount = (total * BigInt(discountBp)) / 10_000n
        const r = invoiceLineNets({ discountSatang: discount, lines: lines.map((l, i) => ({ poLine: i + 1, qty: l.qty, unitPriceSatang: l.price })) }, 700)
        expect(r.discounts.reduce((a, b) => a + b, 0n)).toBe(discount)
        r.nets.forEach((n, i) => expect(n).toBe(amounts[i]! - r.discounts[i]!))
        expect(r.nets.every((n) => n >= 0n)).toBe(true)
      }),
      { numRuns: 3000 },
    )
  })

  it('a matched invoice moves exactly its amount before VAT to ACTUAL, and holds more only for what a line lacks', () => {
    fc.assert(
      fc.property(invoiceLines, fc.boolean(), (lines, generous) => {
        const poLines: MatchPoLine[] = lines.map((l, i) => {
          const held = lineNet(l.qty, l.price)
          return { line: i + 1, ordered: l.qty, unitPriceSatang: l.price, accepted: l.qty, invoiced: '0', heldSatang: held, budgetLine: l.budgetLine }
        })
        // invoice prices up to 1.5 % above the PO: some within the tolerance, some not
        const invoice = { lines: lines.map((l, i) => ({ poLine: i + 1, qty: l.qty, unitPriceSatang: l.price + (l.price * BigInt(l.overBp)) / 10_000n })) }
        const available = generous ? { 'BL-A': 10n ** 15n, 'BL-B': 10n ** 15n, 'BL-C': 10n ** 15n } : { 'BL-A': 0n, 'BL-B': 0n, 'BL-C': 0n }
        const r = matchInvoice({ kind: 'GOODS', poLines, available, invoice }, policy)
        const net = r.lines.reduce((a, l) => a + l.netSatang, 0n)
        expect(r.netSatang).toBe(net)
        if (r.result !== 'MATCHED') return
        expect(r.budget.reduce((a, b) => a + b.actualSatang, 0n)).toBe(net)
        expect(r.poLineMoves.reduce((a, m) => a + m.actualSatang, 0n)).toBe(net)
        for (const m of r.poLineMoves) {
          const po = poLines.find((p) => p.line === m.poLine)!
          expect(m.holdMoreSatang).toBe(m.actualSatang > po.heldSatang ? m.actualSatang - po.heldSatang : 0n)
          // the line never takes more than it holds after the extra hold (INV-BUD-02 of the PO line)
          expect(m.actualSatang).toBeLessThanOrEqual(po.heldSatang + m.holdMoreSatang)
        }
        if (!generous) expect(r.budget.every((b) => b.holdMoreSatang === 0n)).toBe(true)
      }),
      { numRuns: 3000 },
    )
  })
})
