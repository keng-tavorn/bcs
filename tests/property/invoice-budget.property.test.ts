import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { actualize, allocationKey, closePo, emptyLine, fund, holdMore, type LineState } from '@/core/budget'
import { approveVariance, matchInvoice } from '@/core/matching'

// S8-03 (spec §7.7 INV-BUD-01 to INV-BUD-03, §7.18 INV-AP-02): thousands of random runs of a PO and its invoices on
// one budget line. Each invoice is matched by core/matching with what the PO lines hold and what the line has
// available; a matched one is moved by the ledger engine as the service moves it (hold what a line lacks, then
// COMMITTED → ACTUAL, and the last invoice of a closed PO gives back the rest), a price variance is sometimes approved
// (approveVariance). After every step: the buckets add up to what was funded, nothing is below zero, a PO line never
// holds more than its amount plus what was held beyond it for invoices over the PO price, nothing is spent beyond what
// was held, and what moved to ACTUAL is exactly the invoices' amounts before VAT.

const POLICY = { priceTolBp: 100, priceTolSatang: 100_000n, qtyTolBp: 0, vatRateBp: 700 }
const LINE = 'BL'

const poLine = fc.record({ qty: fc.integer({ min: 1, max: 500 }), price: fc.bigInt({ min: 100n, max: 5_000_000n }) })
const invoiceStep = fc.record({
  /** per PO line: share of what is still to invoice, in percent (0 = not on this invoice) */
  shares: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 3, maxLength: 3 }),
  /** price change on the PO price in basis points: under, within and beyond the tolerance */
  priceBp: fc.integer({ min: -300, max: 300 }),
  approve: fc.boolean(),
})

function check(state: LineState, amounts: readonly bigint[], extraHeld: readonly bigint[], everHeld: readonly bigint[]) {
  const b = state.buckets
  // INV-BUD-01
  expect(b.available + b.reserved + b.committed + b.actual).toBe(state.funded)
  // INV-BUD-02
  for (const v of Object.values(b)) expect(v >= 0n).toBe(true)
  amounts.forEach((amount, i) => {
    const a = state.allocations[allocationKey('PO_LINE', `P${i}`)] ?? { reserved: 0n, committed: 0n, actual: 0n }
    expect(a.committed >= 0n && a.actual >= 0n).toBe(true)
    // INV-BUD-03 with the S8 reading: what a PO line holds ≤ its amount + what was held for invoices over the PO price
    expect(a.committed <= amount + extraHeld[i]!).toBe(true)
    // spent never beyond what was ever held
    expect(a.actual <= everHeld[i]!).toBe(true)
  })
}

describe('[FR-AP-102/AC3] [INV-AP-02] invoices keep INV-BUD-01 to INV-BUD-03', () => {
  it('random POs, invoices, variance approvals and a last invoice on a closed PO', () => {
    fc.assert(
      fc.property(fc.array(poLine, { minLength: 1, maxLength: 3 }), fc.array(invoiceStep, { minLength: 1, maxLength: 6 }), fc.bigInt({ min: 0n, max: 200_000_000n }), fc.boolean(), (lines, steps, spare, closeAtEnd) => {
        const amounts = lines.map((l) => BigInt(l.qty) * l.price)
        const total = amounts.reduce((a, b) => a + b, 0n)
        let state = emptyLine()
        const step = (r: ReturnType<typeof fund>) => {
          expect(r.ok).toBe(true)
          if (r.ok) state = r.state
        }
        step(fund(state, total + spare, 'IMPORT-1'))
        // the PO approved: each line holds its amount (as approvePo leaves it)
        amounts.forEach((a, i) => step(holdMore(state, `P${i}`, a)))
        const extraHeld = amounts.map(() => 0n)
        const everHeld = [...amounts]
        const invoicedQty = lines.map(() => 0)
        let actualTotal = 0n
        let invoicedNet = 0n
        check(state, amounts, extraHeld, everHeld)
        steps.forEach((s, n) => {
          const last = closeAtEnd && n === steps.length - 1
          const invoiceLines = lines
            .map((l, i) => ({ i, qty: Math.floor(((l.qty - invoicedQty[i]!) * s.shares[i]!) / 100) }))
            .filter((x) => x.qty > 0)
            .map((x) => ({ poLine: x.i + 1, qty: String(x.qty), unitPriceSatang: lines[x.i]!.price + (lines[x.i]!.price * BigInt(s.priceBp)) / 10_000n }))
          if (invoiceLines.length === 0) return
          const held = (i: number) => state.allocations[allocationKey('PO_LINE', `P${i}`)]?.committed ?? 0n
          const poLines = lines.map((l, i) => ({ line: i + 1, ordered: String(l.qty), unitPriceSatang: l.price, accepted: String(l.qty), invoiced: String(invoicedQty[i]), heldSatang: held(i), budgetLine: LINE }))
          const invoice = { lines: invoiceLines, isFinal: last }
          const r = matchInvoice({ kind: 'GOODS', poClosed: last, poLines, available: { [LINE]: state.buckets.available }, invoice }, POLICY)
          let moves: ReadonlyArray<{ poLine: number; holdMoreSatang: bigint; actualSatang: bigint }> | null = null
          if (r.result === 'MATCHED') moves = r.poLineMoves
          else if (s.approve && r.exceptions.every((e) => e.type === 'PRICE_OVER')) {
            const v = approveVariance({ poLines: poLines.map((p) => ({ line: p.line, heldSatang: p.heldSatang, budgetLine: LINE })), available: { [LINE]: state.buckets.available }, invoice, poClosed: last })
            if (v.ok) moves = v.poLineMoves
          }
          if (!moves) return
          for (const m of moves) {
            const i = m.poLine - 1
            if (m.holdMoreSatang > 0n) {
              step(holdMore(state, `P${i}`, m.holdMoreSatang))
              extraHeld[i]! += m.holdMoreSatang
              everHeld[i]! += m.holdMoreSatang
            }
            if (m.actualSatang > 0n) step(actualize(state, `P${i}`, m.actualSatang))
            actualTotal += m.actualSatang
          }
          if (last) lines.forEach((_, i) => step(closePo(state, `P${i}`, 0n)))
          invoicedNet += r.netSatang
          invoiceLines.forEach((l) => (invoicedQty[l.poLine - 1]! += Number(l.qty)))
          // INV-AP-02: what moved to ACTUAL is the invoices' amounts before VAT
          expect(actualTotal).toBe(invoicedNet)
          expect(state.buckets.actual).toBe(invoicedNet)
          if (last) expect(state.buckets.committed).toBe(0n)
          check(state, amounts, extraHeld, everHeld)
        })
      }),
      { numRuns: 2000 },
    )
  })
})
