import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { emptyLine, fund, release, releaseTransfer, reserve, reserveTransfer, transferIn, transferOut, type BudgetResult, type LineState, type Movement, type TransferKind } from '@/core/budget'

// FR-BUD-103 AC2 (S6-15 · BR-BUD-09 · ADR-104): random sequences of funding, request reservations and transfers or
// adjustments over two lines of one fiscal year. After every operation, on each line: INV-BUD-01 (the buckets add up to
// what the line holds) and INV-BUD-02 (nothing below zero); INV-BUD-07 (what the line holds = Σ moved in from OUTSIDE −
// Σ moved out to OUTSIDE, from the ledger rows); INV-BUD-08 (an approved TRANSFER moves out of one line exactly what it
// moves into the other, so Σ of a TRANSFER's movements across OUTSIDE is zero). A refused operation changes nothing.

const LINES = ['A', 'B'] as const
type Line = (typeof LINES)[number]
const amount = fc.bigInt({ min: 1n, max: 200_000_000n })

type Op =
  | { op: 'fund'; line: Line; amount: bigint }
  | { op: 'reserve'; line: Line; id: string; share: number }
  | { op: 'release'; line: Line; id: string }
  | { op: 'submit'; id: string; kind: TransferKind; from: Line; share: number; fixed: bigint }
  | { op: 'approve'; id: string }
  | { op: 'reject'; id: string }

const TRANSFERS = ['T1', 'T2', 'T3'] as const
const REQUEST_LINES = ['R1', 'R2'] as const
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant('fund' as const), line: fc.constantFrom(...LINES), amount }),
  fc.record({ op: fc.constant('reserve' as const), line: fc.constantFrom(...LINES), id: fc.constantFrom(...REQUEST_LINES), share: fc.integer({ min: 1, max: 80 }) }),
  fc.record({ op: fc.constant('release' as const), line: fc.constantFrom(...LINES), id: fc.constantFrom(...REQUEST_LINES) }),
  // A share of the source's available, sometimes more than it has (refused BUDGET_INSUFFICIENT); an increase asks a fixed amount
  fc.record({
    op: fc.constant('submit' as const),
    id: fc.constantFrom(...TRANSFERS),
    kind: fc.constantFrom('TRANSFER' as const, 'INCREASE' as const, 'DECREASE' as const),
    from: fc.constantFrom(...LINES),
    share: fc.integer({ min: 1, max: 130 }),
    fixed: amount,
  }),
  fc.record({ op: fc.constant('approve' as const), id: fc.constantFrom(...TRANSFERS) }),
  fc.record({ op: fc.constant('reject' as const), id: fc.constantFrom(...TRANSFERS) }),
)

const other = (l: Line): Line => (l === 'A' ? 'B' : 'A')

describe('[FR-BUD-103/AC2] transfers keep every budget line whole (INV-BUD-01 INV-BUD-02 INV-BUD-07 INV-BUD-08)', () => {
  it('1,000 random sequences of 10 to 60 operations on two lines', () => {
    const moved = new Map<string, number>()
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 10, maxLength: 60, size: 'max' }), (ops) => {
        const lines: Record<Line, LineState> = { A: emptyLine(), B: emptyLine() }
        /** Per line: Σ OUTSIDE → line − Σ line → OUTSIDE over every ledger row written (INV-BUD-07) */
        const edge: Record<Line, bigint> = { A: 0n, B: 0n }
        const pending = new Map<string, { kind: TransferKind; from: Line | null; to: Line | null; amount: bigint }>()
        const take = (line: Line, r: BudgetResult) => {
          const before = structuredClone(lines[line])
          if (!r.ok) {
            expect(lines[line]).toEqual(before)
            return null
          }
          lines[line] = r.state
          for (const m of r.movements as readonly Movement[]) {
            expect(m.amount > 0n).toBe(true)
            if (m.from === 'OUTSIDE') edge[line] += m.amount
            if (m.to === 'OUTSIDE') edge[line] -= m.amount
            // BR-BUD-09: only a transfer or an adjustment sends money back OUTSIDE
            if (m.to === 'OUTSIDE') expect(m.sourceType).toBe('BUDGET_TRANSFER')
          }
          return r.movements
        }
        for (const op of ops) {
          switch (op.op) {
            case 'fund':
              take(op.line, fund(lines[op.line], op.amount, 'IMPORT'))
              break
            case 'reserve': {
              const a = (lines[op.line].buckets.available * BigInt(op.share)) / 100n || 1n
              take(op.line, reserve(lines[op.line], [{ requestLineId: `${op.line}-${op.id}`, amount: a }]))
              break
            }
            case 'release':
              take(op.line, release(lines[op.line], [`${op.line}-${op.id}`]))
              break
            case 'submit': {
              if (pending.has(op.id)) break
              if (op.kind === 'INCREASE') {
                pending.set(op.id, { kind: op.kind, from: null, to: op.from, amount: op.fixed })
                break
              }
              const a = (lines[op.from].buckets.available * BigInt(op.share)) / 100n || 1n
              if (take(op.from, reserveTransfer(lines[op.from], op.id, a))) {
                pending.set(op.id, { kind: op.kind, from: op.from, to: op.kind === 'TRANSFER' ? other(op.from) : null, amount: a })
                moved.set('submit', (moved.get('submit') ?? 0) + 1)
              }
              break
            }
            case 'approve': {
              const t = pending.get(op.id)
              if (!t) break
              const out = t.from ? take(t.from, transferOut(lines[t.from], op.id)) : []
              const into = t.to ? take(t.to, transferIn(lines[t.to], op.id, t.amount)) : []
              expect(out).not.toBeNull()
              expect(into).not.toBeNull()
              // INV-BUD-08: a transfer moves out exactly what it moves in
              if (t.kind === 'TRANSFER') {
                const leaving = out!.filter((m) => m.to === 'OUTSIDE').reduce((s, m) => s + m.amount, 0n)
                const arriving = into!.filter((m) => m.from === 'OUTSIDE').reduce((s, m) => s + m.amount, 0n)
                expect(leaving).toBe(arriving)
              }
              pending.delete(op.id)
              moved.set(`approve-${t.kind}`, (moved.get(`approve-${t.kind}`) ?? 0) + 1)
              break
            }
            case 'reject': {
              const t = pending.get(op.id)
              if (!t) break
              if (t.from) take(t.from, releaseTransfer(lines[t.from], op.id))
              pending.delete(op.id)
              break
            }
          }
          for (const l of LINES) {
            const s = lines[l]
            const { available, reserved, committed, actual } = s.buckets
            // INV-BUD-01 and INV-BUD-02
            expect(available + reserved + committed + actual).toBe(s.funded)
            for (const v of [available, reserved, committed, actual, s.funded]) expect(v >= 0n).toBe(true)
            for (const a of Object.values(s.allocations)) for (const v of [a.reserved, a.committed, a.actual]) expect(v >= 0n).toBe(true)
            // INV-BUD-07
            expect(s.funded).toBe(edge[l])
          }
        }
      }),
      { numRuns: 1000 },
    )
    for (const k of ['submit', 'approve-TRANSFER', 'approve-INCREASE', 'approve-DECREASE']) expect(moved.get(k) ?? 0, k).toBeGreaterThan(0)
  })
})
