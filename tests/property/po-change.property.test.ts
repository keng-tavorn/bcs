import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { allocationKey, approvePo, emptyLine, fund, reserve, submitPo, type BudgetResult, type LineState } from '@/core/budget'
import { approveChange, rejectChange, submitChange, type ChangeBudgetLine } from '@/core/po-change'

// S8-10 (spec §7.7 INV-BUD-01 to INV-BUD-03, ADR-125, BR-POC-03): random runs of an approved PO line changed again and
// again on one budget line — prices up and down, quantities added from what the request still holds or taken off
// (back to the pool or cancelled on the request), the money and the quantity moving either way of each other (a price
// cut with more units, a rise with fewer), each change approved, rejected or refused BUDGET_INSUFFICIENT. After
// every step: the buckets add up to what was funded, nothing is below zero, the PO line holds exactly its current
// amount once no change is pending, a pending change holds nothing more than its reservation, and the request line
// never has more reserved than it was given; once approved, the request line has given back exactly the added quantity's
// releasable and, back to the pool, taken the removed quantity's again (BR-POC-03 clause by clause).

const PO = 'P'
const PR = 'R'

const change = fc.record({
  /** the PO line's new amount in percent of the current one (50–150) */
  newPercent: fc.integer({ min: 50, max: 150 }),
  /** the quantity: more units from the request line, fewer, or the same — whatever the money does */
  quantity: fc.constantFrom('UP' as const, 'DOWN' as const, 'SAME' as const),
  /** the releasable of the units added or removed, in percent of the PO line's current amount */
  releasablePercent: fc.integer({ min: 0, max: 60 }),
  decision: fc.constantFrom('APPROVE', 'REJECT'),
  disposition: fc.constantFrom('RETURN_TO_POOL' as const, 'CANCEL_REQUEST_LINES' as const),
})

const held = (s: LineState, sourceType: 'PO_LINE' | 'REQUEST_LINE', id: string) => s.allocations[allocationKey(sourceType, id)] ?? { reserved: 0n, committed: 0n, actual: 0n }

function check(s: LineState) {
  const b = s.buckets
  expect(b.available + b.reserved + b.committed + b.actual).toBe(s.funded)
  for (const v of Object.values(b)) expect(v >= 0n).toBe(true)
  for (const a of Object.values(s.allocations)) expect(a.reserved >= 0n && a.committed >= 0n && a.actual >= 0n).toBe(true)
}

describe('[FR-AP-107/AC1] PO changes keep INV-BUD-01 to INV-BUD-03', () => {
  it('random price and quantity changes approved, rejected or refused on an approved PO line', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 10_000n, max: 10_000_000n }), fc.bigInt({ min: 0n, max: 20_000_000n }), fc.bigInt({ min: 0n, max: 5_000_000n }), fc.array(change, { minLength: 1, maxLength: 8 }), (amount, spare, requestSpare, changes) => {
        const step = (r: BudgetResult, s: LineState) => (r.ok ? r.state : s)
        let s = step(fund(emptyLine(), amount + requestSpare + spare, 'I'), emptyLine())
        s = step(reserve(s, [{ requestLineId: PR, amount: amount + requestSpare }]), s)
        const po = { poLineId: PO, need: amount, sources: [{ requestLineId: PR, releasable: amount }] }
        s = step(submitPo(s, po), s)
        s = step(approvePo(s, po), s)
        check(s)
        let current = amount
        for (const c of changes) {
          const next = (current * BigInt(c.newPercent)) / 100n
          if (next <= 0n) continue
          const delta = next - current
          const units = (current * BigInt(c.releasablePercent)) / 100n
          const reservedForRequest = held(s, 'REQUEST_LINE', PR).reserved
          const give = c.quantity === 'UP' ? (units < reservedForRequest ? units : reservedForRequest) : 0n
          const removed = c.quantity === 'DOWN' ? units : 0n
          const line: ChangeBudgetLine = { poLineId: PO, requestLineId: PR, deltaSatang: delta, addedReleasableSatang: give }
          const submitted = submitChange(s, line)
          if (!submitted.ok) {
            expect(submitted.error.code).toBe('BUDGET_INSUFFICIENT')
            check(s)
            continue
          }
          s = submitted.state
          check(s)
          // pending: the PO line holds its current amount and its reservation only
          expect(held(s, 'PO_LINE', PO).committed).toBe(current)
          if (c.decision === 'REJECT') {
            s = step(rejectChange(s, PO), s)
            check(s)
            expect(held(s, 'PO_LINE', PO)).toMatchObject({ reserved: 0n, committed: current })
            continue
          }
          const before = held(s, 'REQUEST_LINE', PR).reserved
          const approved = approveChange(s, line, c.quantity === 'DOWN' ? { disposition: c.disposition, removedReleasableSatang: removed } : null)
          if (!approved.ok) {
            // giving the removed quantity back to the pool needs it available: refused, nothing moves
            expect(approved.error.code).toBe('BUDGET_INSUFFICIENT')
            s = step(rejectChange(s, PO), s)
            check(s)
            continue
          }
          s = approved.state
          current = next
          check(s)
          // INV-BUD-03: once decided the PO line holds exactly its amount, and reserves nothing
          expect(held(s, 'PO_LINE', PO)).toMatchObject({ reserved: 0n, committed: current })
          expect(held(s, 'REQUEST_LINE', PR).reserved).toBe(before - give + (c.disposition === 'RETURN_TO_POOL' ? removed : 0n))
        }
      }),
      { numRuns: 2_000 },
    )
  })
})
