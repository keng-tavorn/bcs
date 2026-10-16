import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  actualize,
  allocationKey,
  approvePo,
  closePo,
  consumeOverrun,
  earmarkOf,
  earmarkOverrun,
  emptyLine,
  fund,
  lapseOverrun,
  netReturned,
  overrunDoaInput,
  release,
  reserve,
  returnAfterUse,
  type BudgetResult,
  type LineState,
  type Movement,
} from '@/core/budget'

// FR-BUD-101 AC2 (S6-16 · BR-BUD-12 to BR-BUD-15, BR-BUD-18 · ADR-105): random sequences on one budget line of funding,
// request reservations and releases, over-budget approvals (earmark), their use at submit and their lapse, approved POs
// and closed POs. A command that gives back what a request holds returns, after use, what was funded for it (BR-BUD-18).
// After every operation: INV-BUD-01 and INV-BUD-02 (the buckets add up to what the line holds, nothing below zero),
// INV-BUD-07 (what the line holds = Σ in from OUTSIDE − Σ out to OUTSIDE), INV-BUD-09 (a used or lapsed overrun
// earmarks nothing, used + returned = X, returned after use ≤ used, and its ledger rows across OUTSIDE add up to used −
// returned after use) and INV-BUD-10 (what is still outstanding of a request's overruns ≤ what the request and its PO
// lines hold: the amount funded never becomes another document's available budget).

const REQUESTS = ['R1', 'R2'] as const
const OVERRUNS = ['O1', 'O2', 'O3'] as const
const POS = ['P1', 'P2'] as const
const amount = fc.bigInt({ min: 1n, max: 50_000_000n })
const share = fc.integer({ min: 1, max: 120 })

type Op =
  | { op: 'fund'; amount: bigint }
  | { op: 'reserve'; request: string; share: number }
  | { op: 'release'; request: string }
  | { op: 'approveOverrun'; id: string; request: string; extra: bigint }
  | { op: 'consume'; id: string; share: number }
  | { op: 'lapse'; id: string }
  | { op: 'approvePo'; po: string; request: string; release: number; hold: number }
  | { op: 'closePo'; po: string; actual: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant('fund' as const), amount }),
  fc.record({ op: fc.constant('reserve' as const), request: fc.constantFrom(...REQUESTS), share }),
  fc.record({ op: fc.constant('release' as const), request: fc.constantFrom(...REQUESTS) }),
  fc.record({ op: fc.constant('approveOverrun' as const), id: fc.constantFrom(...OVERRUNS), request: fc.constantFrom(...REQUESTS), extra: amount }),
  fc.record({ op: fc.constant('consume' as const), id: fc.constantFrom(...OVERRUNS), share: fc.integer({ min: 1, max: 160 }) }),
  fc.record({ op: fc.constant('lapse' as const), id: fc.constantFrom(...OVERRUNS) }),
  fc.record({ op: fc.constant('approvePo' as const), po: fc.constantFrom(...POS), request: fc.constantFrom(...REQUESTS), release: fc.integer({ min: 0, max: 100 }), hold: fc.integer({ min: 1, max: 150 }) }),
  fc.record({ op: fc.constant('closePo' as const), po: fc.constantFrom(...POS), actual: fc.integer({ min: 0, max: 100 }) }),
)

interface Overrun {
  request: string
  x: bigint
  status: 'APPROVED' | 'CONSUMED' | 'LAPSED'
  used: bigint
  returned: bigint
  afterUse: bigint
  seq: number
}

describe('[FR-BUD-101/AC2] over-budget approval keeps the line whole (INV-BUD-01 INV-BUD-02 INV-BUD-07 INV-BUD-09 INV-BUD-10)', () => {
  it('1,000 random sequences of 10 to 60 operations', () => {
    const seen = new Map<string, number>()
    const count = (k: string) => seen.set(k, (seen.get(k) ?? 0) + 1)
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 10, maxLength: 60, size: 'max' }), (ops) => {
        let line: LineState = emptyLine()
        let edge = 0n
        /** Per overrun: Σ OUTSIDE → line − Σ line → OUTSIDE of its own ledger rows */
        const overrunEdge = new Map<string, bigint>()
        const overruns = new Map<string, Overrun>()
        const poRequest = new Map<string, string>()
        let seq = 0
        const write = (movements: readonly Movement[]) => {
          for (const m of movements) {
            expect(m.amount > 0n).toBe(true)
            const signed = m.from === 'OUTSIDE' ? m.amount : m.to === 'OUTSIDE' ? -m.amount : 0n
            edge += signed
            // BR-BUD-09: an overrun's money crosses the line's edge only under its own source
            if (signed !== 0n) {
              expect(m.sourceType === 'BUDGET_OVERRUN' || (m.sourceType === 'IMPORT' && signed > 0n)).toBe(true)
              if (m.sourceType === 'BUDGET_OVERRUN') overrunEdge.set(m.sourceId, (overrunEdge.get(m.sourceId) ?? 0n) + signed)
            }
          }
        }
        const take = (r: BudgetResult) => {
          if (!r.ok) return null
          line = r.state
          write(r.movements)
          return r.movements
        }
        /** BR-BUD-18 after one command: what it gave back of each request leaves the line, to the overrun used last first */
        const afterUse = (movements: readonly Movement[] | null) => {
          if (!movements) return
          for (const request of REQUESTS) {
            const used = [...overruns].filter(([, o]) => o.request === request && o.status === 'CONSUMED').sort(([, a], [, b]) => b.seq - a.seq)
            if (used.length === 0) continue
            const keys = new Set([allocationKey('REQUEST_LINE', request), ...[...poRequest].filter(([, r]) => r === request).map(([po]) => allocationKey('PO_LINE', po))])
            const r = returnAfterUse(line, netReturned(movements, keys), used.map(([id, o]) => ({ id, outstanding: o.used - o.afterUse })))
            line = r.state
            write(r.movements)
            for (const [id, s] of r.returned) {
              overruns.get(id)!.afterUse += s
              count('returnedAfterUse')
            }
          }
        }
        const holdings = (request: string) => {
          const keys = [allocationKey('REQUEST_LINE', request), ...[...poRequest].filter(([, r]) => r === request).map(([po]) => allocationKey('PO_LINE', po))]
          return keys.reduce((s, k) => {
            const a = line.allocations[k]
            return a ? s + a.reserved + a.committed + a.actual : s
          }, 0n)
        }
        const reservedBy = (request: string) => line.allocations[allocationKey('REQUEST_LINE', request)]?.reserved ?? 0n

        for (const op of ops) {
          switch (op.op) {
            case 'fund':
              take(fund(line, op.amount, 'IMPORT'))
              break
            case 'reserve': {
              const a = (line.buckets.available * BigInt(op.share)) / 100n || 1n
              take(reserve(line, [{ requestLineId: op.request, amount: a }]))
              break
            }
            case 'release':
              afterUse(take(release(line, [op.request])))
              break
            case 'approveOverrun': {
              // One live overrun per request (the partial unique index)
              if (overruns.has(op.id) || [...overruns.values()].some((o) => o.request === op.request && o.status === 'APPROVED')) break
              const doa = overrunDoaInput({ needSatang: line.buckets.available + op.extra, availableSatang: line.buckets.available, lineDepartmentId: 'D', requesterMemberId: 'u1' })
              expect(doa.ok).toBe(true)
              const x = doa.ok ? doa.input.amount.netSatang : 0n
              expect(x).toBe(op.extra)
              if (take(earmarkOverrun(line, op.id, x))) overruns.set(op.id, { request: op.request, x, status: 'APPROVED', used: 0n, returned: 0n, afterUse: 0n, seq: 0 })
              break
            }
            case 'consume': {
              const o = overruns.get(op.id)
              if (!o || o.status !== 'APPROVED') break
              // M as a share of what the request could have: sometimes more (refused, nothing moves)
              const m = ((line.buckets.available + earmarkOf(line, op.id)) * BigInt(op.share)) / 100n || 1n
              const before = line
              const r = consumeOverrun(line, op.id, [{ requestLineId: o.request, amount: m }])
              if (!r.ok) {
                expect(r.error.code).toBe('BUDGET_INSUFFICIENT')
                expect(line).toBe(before)
                count('refused')
                break
              }
              line = r.state
              write(r.movements)
              Object.assign(o, { status: 'CONSUMED', used: r.used, returned: r.returned, seq: ++seq })
              count('consumed')
              break
            }
            case 'lapse': {
              const o = overruns.get(op.id)
              if (!o || o.status !== 'APPROVED') break
              const r = lapseOverrun(line, op.id)
              line = r.state
              write(r.movements)
              Object.assign(o, { status: 'LAPSED', used: r.used, returned: r.returned })
              count('lapsed')
              break
            }
            case 'approvePo': {
              if (poRequest.has(op.po)) break
              const releasable = (reservedBy(op.request) * BigInt(op.release)) / 100n
              const need = ((releasable + line.buckets.available) * BigInt(op.hold)) / 100n || 1n
              const moved = take(approvePo(line, { poLineId: op.po, need, sources: [{ requestLineId: op.request, releasable }] }))
              if (moved) {
                poRequest.set(op.po, op.request)
                afterUse(moved)
                count('po')
              }
              break
            }
            case 'closePo': {
              if (!poRequest.has(op.po)) break
              const held = line.allocations[allocationKey('PO_LINE', op.po)]?.committed ?? 0n
              const invoiced = (held * BigInt(op.actual)) / 100n
              const first = invoiced > 0n ? take(actualize(line, op.po, invoiced)) : []
              const second = take(closePo(line, op.po))
              afterUse([...(first ?? []), ...(second ?? [])])
              break
            }
          }
          const { available, reserved, committed, actual } = line.buckets
          // INV-BUD-01 · INV-BUD-02 · INV-BUD-07
          expect(available + reserved + committed + actual).toBe(line.funded)
          for (const v of [available, reserved, committed, actual, line.funded]) expect(v >= 0n).toBe(true)
          for (const a of Object.values(line.allocations)) for (const v of [a.reserved, a.committed, a.actual]) expect(v >= 0n).toBe(true)
          expect(line.funded).toBe(edge)
          for (const [id, o] of overruns) {
            if (o.status === 'APPROVED') {
              expect(earmarkOf(line, id)).toBe(o.x)
              continue
            }
            // INV-BUD-09
            expect(earmarkOf(line, id)).toBe(0n)
            expect(o.used + o.returned).toBe(o.x)
            expect(o.afterUse <= o.used).toBe(true)
            expect(overrunEdge.get(id) ?? 0n).toBe(o.used - o.afterUse)
          }
          // INV-BUD-10
          for (const request of REQUESTS) {
            const outstanding = [...overruns.values()].filter((o) => o.request === request && o.status === 'CONSUMED').reduce((s, o) => s + o.used - o.afterUse, 0n)
            expect(outstanding <= holdings(request)).toBe(true)
          }
        }
      }),
      { numRuns: 1000 },
    )
    for (const k of ['consumed', 'refused', 'lapsed', 'po', 'returnedAfterUse']) expect(seen.get(k) ?? 0, k).toBeGreaterThan(0)
  })
})
