import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { awardAmount, compareBids, isLateBid, preferredInEffect, preferredWindow, weightedScoreBp } from '@/core/sourcing'

// S10-03 (spec §7.23 · INV-RFX-02 INV-RFX-05): on random bids and scores the comparison table adds up — Σ lineNet = net
// and gross = net + vat for every bid, with or without VAT in the price; an award's net is its lines', its VAT its
// suppliers'; the weighted total stays within 0–10000 and is the same twice; a bid at the closing instant is late; a
// preferred supplier's period does not include its end day.

const quantity = fc.tuple(fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 0, max: 9999 })).map(([w, f]) => (f === 0 ? String(w) : `${w}.${String(f).padStart(4, '0').replace(/0+$/, '')}`))
const price = fc.bigInt({ min: 1n, max: 100_000_000n })
const rate = fc.constantFrom(0, 700, 1000)

describe('sourcing engine properties', () => {
  it('[INV-RFX-05] Σ lineNet = net and gross = net + vat for every bid', () => {
    fc.assert(
      fc.property(
        fc.array(quantity, { minLength: 1, maxLength: 6 }),
        fc.array(fc.record({ includesVat: fc.boolean(), rateBp: rate, prices: fc.array(fc.option(price, { nil: undefined }), { minLength: 6, maxLength: 6 }) }), { minLength: 1, maxLength: 4 }),
        (qs, raw) => {
          const lines = qs.map((q, i) => ({ ref: `L${i}`, quantity: q }))
          const bids = raw.map((b, n) => ({
            ref: `B${n}`,
            priceIncludesVat: b.includesVat,
            vatRateBp: b.rateBp,
            unitPrices: Object.fromEntries(lines.flatMap((l, i) => (b.prices[i] === undefined ? [] : [[l.ref, b.prices[i]!] as const]))),
          }))
          const r = compareBids(lines, bids)
          for (const b of r.bids) {
            expect(b.lineNet.reduce((a, [, v]) => a + v, 0n)).toBe(b.net)
            expect(b.gross).toBe(b.net + b.vat)
            expect(b.vat >= 0n).toBe(true)
          }
          for (const ref of r.lowest) expect(r.bids.find((b) => b.ref === ref)!.net).toBe(r.lowestNet)
        },
      ),
    )
  })

  it('[INV-RFX-05] an award is its lines before VAT and its suppliers’ VAT', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ supplier: fc.constantFrom('s1', 's2', 's3'), q: quantity, p: price }), { minLength: 1, maxLength: 8 }), fc.record({ s1: rate, s2: rate, s3: rate }), (raw, rates) => {
        const r = awardAmount(raw.map((l, i) => ({ ref: `L${i}`, supplierId: l.supplier, quantity: l.q, unitPriceSatang: l.p, vatRateBp: rates[l.supplier] })))
        expect(r.lineNet.reduce((a, [, v]) => a + v, 0n)).toBe(r.net)
        expect(r.perSupplier.reduce((a, s) => a + s.net, 0n)).toBe(r.net)
        expect(r.perSupplier.reduce((a, s) => a + s.vat, 0n)).toBe(r.vat)
        expect(r.gross).toBe(r.net + r.vat)
        expect(r.isSplit).toBe(new Set(raw.map((l) => l.supplier)).size > 1)
      }),
    )
  })

  it('[INV-RFX-02] the weighted total is within 0–10000 and the same every time', () => {
    const scorecard = fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: 1, maxLength: 6 }).chain((cuts) => {
      // weights that add up to 10000: the gaps between sorted cut points
      const points = [0, ...[...cuts].sort((a, b) => a - b), 10000]
      const weights = points.slice(1).map((p, i) => p - points[i]!)
      return fc.tuple(fc.constant(weights), fc.array(fc.integer({ min: 0, max: 10000 }), { minLength: weights.length, maxLength: weights.length }))
    })
    fc.assert(
      fc.property(scorecard, ([weights, scores]) => {
        const criteria = weights.map((weightBp, i) => ({ weightBp, scoreBp: scores[i]! }))
        const total = weightedScoreBp(criteria)
        expect(total).toBeGreaterThanOrEqual(0)
        expect(total).toBeLessThanOrEqual(10000)
        expect(weightedScoreBp(criteria)).toBe(total)
      }),
    )
  })

  it('a bid at the closing instant is late, a moment before is not', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }), (closesAt) => {
        expect(isLateBid(closesAt, closesAt)).toBe(true)
        expect(isLateBid(new Date(closesAt.getTime() - 1), closesAt)).toBe(false)
      }),
    )
  })

  it('a preferred supplier’s period includes its first day and not its end day', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }), fc.integer({ min: 1, max: 1000 }), (approvedAt, days) => {
        const w = preferredWindow(approvedAt, days)
        expect(preferredInEffect(w, w.validFrom)).toBe(true)
        expect(preferredInEffect(w, w.validTo)).toBe(false)
      }),
    )
  })
})
