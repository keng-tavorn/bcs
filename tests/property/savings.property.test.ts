import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { lineNet } from '@/core/money/math'
import { findSavings, type OpenLine, type Purchase, type SavingsAgreement } from '@/core/savings'

// NEW-123 (spec §7.21 BR-SAV-01 to BR-SAV-06): on thousands of random pools, histories and agreed prices, every saving is
// positive and is what buying the line at the lower price saves, services never count above history or across
// departments, a line counts once in the total, and the result does not depend on the order the rows arrive in.

const at = new Date('2026-10-06T03:00:00Z')
const settings = { at, today: '2026-10-06', windowDays: 365, minSamples: 3, alertBp: 1000, agreementDays: 30 }
const qty = fc.integer({ min: 1, max: 2_000_000 }).map((n) => (n % 10_000 === 0 ? String(n / 10_000) : (n / 10_000).toFixed(4)))
const price = fc.bigInt({ min: 1n, max: 5_000_000n })
const item = fc.constantFrom('A', 'B', 'C')

const lines = fc.uniqueArray(
  fc.record({
    ref: fc.integer({ min: 1, max: 999 }).map((n) => `L${String(n).padStart(3, '0')}`),
    stage: fc.constantFrom<OpenLine['stage']>('PENDING_APPROVAL', 'POOL'),
    item,
    catalogue: fc.boolean(),
    kind: fc.constantFrom<OpenLine['kind']>('GOODS', 'SERVICE'),
    departmentId: fc.constantFrom('CON', 'ENG', 'HR'),
    siteId: fc.constantFrom('HQ', 'SITE-B', null),
    supplierId: fc.constantFrom('S1', 'S2', 'S3', null),
    quantity: qty,
    unitPriceSatang: price,
    priceIncludesVat: fc.boolean(),
  }),
  { selector: (l) => l.ref, maxLength: 12 },
).map((ls) =>
  ls.map(({ item: i, catalogue, ...l }): OpenLine => ({ ...l, key: catalogue ? `item:${i}` : `${i}|ชิ้น`, catalogItemId: catalogue ? i : null })),
)

const purchases = fc.uniqueArray(
  fc.record({
    ref: fc.integer({ min: 1, max: 999 }).map((n) => `P${String(n).padStart(3, '0')}`),
    item,
    catalogue: fc.boolean(),
    daysAgo: fc.integer({ min: 0, max: 400 }),
    unitPriceSatang: price,
    quantity: qty,
    priceIncludesVat: fc.boolean(),
    agreement: fc.constantFrom('G1', 'G2', 'G3', null),
  }),
  { selector: (p) => p.ref, maxLength: 15 },
).map((ps) =>
  ps.map(
    (p): Purchase => ({
      ref: p.ref,
      key: p.catalogue ? `item:${p.item}` : `${p.item}|ชิ้น`,
      approvedAt: new Date(at.getTime() - p.daysAgo * 86_400_000 - 1),
      unitPriceSatang: p.unitPriceSatang,
      priceIncludesVat: p.priceIncludesVat,
      agreements: p.agreement ? [{ id: p.agreement, quantity: p.quantity }] : [],
    }),
  ),
)

const day = (offset: number) => new Date(Date.UTC(2026, 9, 6 + offset)).toISOString().slice(0, 10)
const agreements = fc
  .array(
    fc.record({
      item,
      supplierId: fc.constantFrom('S1', 'S2', 'S3'),
      from: fc.integer({ min: -400, max: 40 }),
      length: fc.integer({ min: 1, max: 400 }),
      unitPriceSatang: price,
      ended: fc.boolean(),
    }),
    { maxLength: 6 },
  )
  .map((as) =>
    as.map(
      (a, i): SavingsAgreement => ({ id: `G${i + 1}`, catalogItemId: a.item, supplierId: a.supplierId, validFrom: day(a.from), validTo: day(a.from + a.length), unitPriceSatang: a.unitPriceSatang, ended: a.ended }),
    ),
  )

describe('[FR-VIS-008/AC1] savings properties', () => {
  it('every saving is positive and is a line bought at the lower price; the total counts each line once', () => {
    fc.assert(
      fc.property(lines, purchases, agreements, (ls, ps, as) => {
        const r = findSavings({ lines: ls, purchases: ps, agreements: as }, settings)
        const byRef = new Map(ls.map((l) => [l.ref, l]))
        const largest = new Map<string, bigint>()
        const keep = (ref: string, s: bigint) => largest.set(ref, (largest.get(ref) ?? 0n) > s ? largest.get(ref)! : s)
        for (const o of r.opportunities) {
          if (o.kind === 'AGREEMENT_EXPIRING') {
            expect(o.savingSatang).toBeNull()
            expect(o.daysLeft).toBeGreaterThan(0)
            expect(o.daysLeft).toBeLessThanOrEqual(settings.agreementDays)
            continue
          }
          expect(o.savingSatang > 0n).toBe(true)
          if (o.kind === 'SAME_ITEM_DEPARTMENTS') {
            expect(o.lines.reduce((s, l) => s + l.savingSatang, 0n)).toBe(o.savingSatang)
            for (const l of o.lines) {
              const line = byRef.get(l.ref)!
              expect(l.savingSatang).toBe(lineNet(line.quantity, line.unitPriceSatang) - lineNet(line.quantity, o.lowestSatang))
              expect(l.savingSatang >= 0n).toBe(true)
              // services are priced per job: never grouped (BR-SAV-03)
              expect([line.kind, line.stage]).toEqual(['GOODS', 'POOL'])
              keep(l.ref, l.savingSatang)
            }
            expect(new Set(o.lines.map((l) => byRef.get(l.ref)!.departmentId)).size).toBe(o.departments)
            expect(o.departments).toBeGreaterThanOrEqual(2)
          } else {
            const line = byRef.get(o.line)!
            const lower = o.kind === 'PRICE_ABOVE_HISTORY' ? o.referenceSatang : o.agreedSatang
            expect(lower < line.unitPriceSatang).toBe(true)
            expect(o.savingSatang).toBe(lineNet(line.quantity, line.unitPriceSatang) - lineNet(line.quantity, lower))
            expect(line.priceIncludesVat).toBe(false)
            // a service is never above history (BR-SAV-01); an agreed price of a service still counts (BR-SAV-02)
            if (o.kind === 'PRICE_ABOVE_HISTORY') expect(line.kind).toBe('GOODS')
            keep(o.line, o.savingSatang)
          }
        }
        expect(r.totalSatang).toBe([...largest.values()].reduce((s, v) => s + v, 0n))
        // the savings come first, the largest first (BR-SAV-05)
        const amounts = r.opportunities.map((o) => o.savingSatang)
        const firstNull = amounts.indexOf(null)
        expect(amounts.slice(firstNull === -1 ? amounts.length : firstNull).every((a) => a === null)).toBe(true)
        const saved = amounts.filter((a): a is bigint => a !== null)
        saved.forEach((a, i) => i > 0 && expect(a <= saved[i - 1]!).toBe(true))
      }),
      { numRuns: 2000 },
    )
  })

  it('gives the same result whatever order the lines, purchases and agreed prices come in', () => {
    fc.assert(
      fc.property(lines, purchases, agreements, fc.integer(), (ls, ps, as, seed) => {
        const shuffle = <T,>(xs: readonly T[]) => [...xs].map((x, i) => ({ x, k: (i * 7919 + seed) % 104_729 })).sort((a, b) => a.k - b.k).map((e) => e.x)
        expect(findSavings({ lines: shuffle(ls), purchases: shuffle(ps), agreements: shuffle(as) }, settings)).toEqual(findSavings({ lines: ls, purchases: ps, agreements: as }, settings))
      }),
      { numRuns: 1000 },
    )
  })
})
