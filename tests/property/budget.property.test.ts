import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { actualize, approvePo, cancelPo, closePo, emptyLine, fund, rejectPo, release, reserve, submitPo, type BudgetResult, type LineState, type PoLine } from '@/core/budget'

// FR-BUD-002 AC2 (spec §7.7): thousands of random sequences of budget operations on one line; after every operation
// INV-BUD-01 (the four buckets add up to what was funded), INV-BUD-02 (no bucket and no allocation below zero) and
// INV-BUD-03 (a request line holds no more than it asked, a PO line holds no more than its amount, an invoice never
// exceeds what was held) hold, and the buckets equal the sum of what the document lines hold. A refused operation
// leaves the state exactly as it was.

const REQUEST_LINES = ['R1', 'R2', 'R3', 'R4'] as const
const PO_LINES = ['P1', 'P2', 'P3'] as const
/** Amounts funded: up to 2,000,000.00 baht, in satang, including odd satang */
const amount = fc.bigInt({ min: 1n, max: 200_000_000n })

type Op =
  | { op: 'fund'; amount: bigint }
  | { op: 'reserve'; lines: Array<{ id: string; share: number }> }
  | { op: 'release'; ids: string[] }
  | { op: 'submitPo'; po: string; needPct: number; sources: Array<{ id: string; share: number }> }
  | { op: 'approvePo'; po: string }
  | { op: 'rejectPo'; po: string }
  | { op: 'cancelPo'; po: string; disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES' }
  | { op: 'actualize'; po: string; share: number }
  | { op: 'closePo'; po: string; keepPct: number }
  | { op: 'status'; status: 'OPEN' | 'FROZEN' }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant('fund' as const), amount }),
  // Each line asks for a share of what is available, in percent: together they sometimes ask for more (refused)
  fc.record({ op: fc.constant('reserve' as const), lines: fc.array(fc.record({ id: fc.constantFrom(...REQUEST_LINES), share: fc.integer({ min: 1, max: 70 }) }), { minLength: 1, maxLength: 3 }) }),
  fc.record({ op: fc.constant('release' as const), ids: fc.subarray([...REQUEST_LINES], { minLength: 1 }) }),
  fc.record({
    op: fc.constant('submitPo' as const),
    po: fc.constantFrom(...PO_LINES),
    // The PO costs 50–150% of what its sources give back: cheaper, the same, or dearer (a delta to reserve)
    needPct: fc.integer({ min: 50, max: 150 }),
    // Each source gives back a share of what its request line holds, in percent
    sources: fc.array(fc.record({ id: fc.constantFrom(...REQUEST_LINES), share: fc.integer({ min: 0, max: 100 }) }), { minLength: 1, maxLength: 2 }),
  }),
  fc.record({ op: fc.constant('approvePo' as const), po: fc.constantFrom(...PO_LINES) }),
  fc.record({ op: fc.constant('rejectPo' as const), po: fc.constantFrom(...PO_LINES) }),
  fc.record({ op: fc.constant('cancelPo' as const), po: fc.constantFrom(...PO_LINES), disposition: fc.constantFrom('RETURN_TO_POOL' as const, 'CANCEL_REQUEST_LINES' as const) }),
  // An invoice for a share of what the PO line holds, sometimes more than it holds (refused)
  fc.record({ op: fc.constant('actualize' as const), po: fc.constantFrom(...PO_LINES), share: fc.integer({ min: 1, max: 120 }) }),
  // Closing keeps nothing, or a share of what the PO line holds (received but not yet invoiced, BR-BUD-06)
  fc.record({ op: fc.constant('closePo' as const), po: fc.constantFrom(...PO_LINES), keepPct: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 100 })) }),
  fc.record({ op: fc.constant('status' as const), status: fc.constantFrom('OPEN' as const, 'FROZEN' as const) }),
)

/** What the documents asked for, to check INV-BUD-03 against */
interface Asked {
  /** Per request line: everything it ever reserved minus what it gave back by release (an upper bound of what it holds) */
  requested: Map<string, bigint>
  /** Per PO line: its amount while it is submitted or approved */
  poNeed: Map<string, bigint>
  /** Per PO line: everything it was ever given to hold (each AVAILABLE → COMMITTED movement) */
  everCommitted: Map<string, bigint>
}

function checkInvariants(state: LineState, asked: Asked) {
  const { available, reserved, committed, actual } = state.buckets
  // INV-BUD-01
  expect(available + reserved + committed + actual).toBe(state.funded)
  // INV-BUD-02
  for (const v of [available, reserved, committed, actual]) expect(v >= 0n).toBe(true)
  const allocations = Object.entries(state.allocations)
  for (const [, a] of allocations) for (const v of [a.reserved, a.committed, a.actual]) expect(v >= 0n).toBe(true)
  // The buckets are the sum of what the document lines hold (BudgetLineBalance = Σ BudgetAllocation)
  expect(allocations.reduce((s, [, a]) => s + a.reserved, 0n)).toBe(reserved)
  expect(allocations.reduce((s, [, a]) => s + a.committed, 0n)).toBe(committed)
  expect(allocations.reduce((s, [, a]) => s + a.actual, 0n)).toBe(actual)
  // INV-BUD-03
  for (const [key, a] of allocations) {
    const [type, id] = key.split(':') as ['REQUEST_LINE' | 'PO_LINE', string]
    if (type === 'REQUEST_LINE') expect(a.reserved <= (asked.requested.get(id) ?? 0n)).toBe(true)
    else {
      if (a.committed > 0n) expect(a.committed <= (asked.poNeed.get(id) ?? 0n)).toBe(true)
      expect(a.actual <= (asked.everCommitted.get(id) ?? 0n)).toBe(true)
    }
  }
}

/** Where each PO line is in its life (the PO state machine of §6.4 allows only these steps) */
type PoPhase = 'SUBMITTED' | 'APPROVED'

function step(state: LineState, op: Op, pos: Map<string, PoLine>, phase: Map<string, PoPhase>, asked: Asked): BudgetResult {
  const skip: BudgetResult = { ok: true, state, movements: [] }
  switch (op.op) {
    case 'fund':
      return fund(state, op.amount, 'IMPORT')
    case 'reserve': {
      const lines = op.lines.map((l) => ({ requestLineId: l.id, amount: (state.buckets.available * BigInt(l.share)) / 100n || 1n }))
      const result = reserve(state, lines)
      if (result.ok) for (const l of lines) asked.requested.set(l.requestLineId, (asked.requested.get(l.requestLineId) ?? 0n) + l.amount)
      return result
    }
    case 'release':
      return release(state, op.ids)
    case 'submitPo': {
      // A PO line already submitted keeps its sources until it is approved, rejected, cancelled or closed
      if (phase.has(op.po)) return skip
      const sources = op.sources.map((s) => ({ requestLineId: s.id, releasable: ((state.allocations[`REQUEST_LINE:${s.id}`]?.reserved ?? 0n) * BigInt(s.share)) / 100n }))
      const unique = sources.filter((s, i) => sources.findIndex((x) => x.requestLineId === s.requestLineId) === i)
      const back = unique.reduce((sum, s) => sum + s.releasable, 0n)
      const need = (back * BigInt(op.needPct)) / 100n || 1n
      const po: PoLine = { poLineId: op.po, need, sources: unique }
      const result = submitPo(state, po)
      if (result.ok) {
        pos.set(op.po, po)
        phase.set(op.po, 'SUBMITTED')
        asked.poNeed.set(op.po, need)
      }
      return result
    }
    case 'approvePo': {
      if (phase.get(op.po) !== 'SUBMITTED') return skip
      const result = approvePo(state, pos.get(op.po)!)
      if (result.ok) phase.set(op.po, 'APPROVED')
      return result
    }
    case 'rejectPo': {
      if (phase.get(op.po) !== 'SUBMITTED') return skip
      const result = rejectPo(state, op.po)
      if (result.ok) phase.delete(op.po)
      return result
    }
    case 'cancelPo': {
      if (!phase.has(op.po)) return skip
      const result = cancelPo(state, pos.get(op.po)!, op.disposition)
      if (result.ok) phase.delete(op.po)
      return result
    }
    case 'actualize': {
      if (phase.get(op.po) !== 'APPROVED') return skip
      const held = state.allocations[`PO_LINE:${op.po}`]?.committed ?? 0n
      return actualize(state, op.po, (held * BigInt(op.share)) / 100n || 1n)
    }
    case 'closePo': {
      if (phase.get(op.po) !== 'APPROVED') return skip
      const keep = ((state.allocations[`PO_LINE:${op.po}`]?.committed ?? 0n) * BigInt(op.keepPct)) / 100n
      const result = closePo(state, op.po, keep)
      if (result.ok && keep === 0n) phase.delete(op.po)
      return result
    }
    case 'status':
      return { ok: true, state: { ...state, status: op.status }, movements: [] }
  }
}

describe('[FR-BUD-002/AC2] budget invariants hold after every operation of a random sequence (INV-BUD-01 to INV-BUD-03)', () => {
  it('1,000 random sequences of 10 to 80 operations', () => {
    // How often each operation moved money, so a generator that never reaches approvals or invoices is caught
    const moved = new Map<string, number>()
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 10, maxLength: 80, size: 'max' }), (ops) => {
        let state = emptyLine()
        const pos = new Map<string, PoLine>()
        const phase = new Map<string, PoPhase>()
        const asked: Asked = { requested: new Map(), poNeed: new Map(), everCommitted: new Map() }
        for (const op of ops) {
          const before = structuredClone(state)
          const result = step(state, op, pos, phase, asked)
          // The engine never changes the state it is given; a refusal leaves the line as it was
          expect(state).toEqual(before)
          if (!result.ok) continue
          if (result.movements.length) moved.set(op.op, (moved.get(op.op) ?? 0) + 1)
          state = result.state
          // Every movement moves a positive amount between two different buckets
          for (const m of result.movements) {
            expect(m.amount > 0n).toBe(true)
            expect(m.from).not.toBe(m.to)
          }
          for (const m of result.movements) {
            if (m.to === 'COMMITTED' && m.sourceType === 'PO_LINE') asked.everCommitted.set(m.sourceId, (asked.everCommitted.get(m.sourceId) ?? 0n) + m.amount)
          }
          checkInvariants(state, asked)
        }
      }),
      { numRuns: 1000 },
    )
    for (const op of ['fund', 'reserve', 'release', 'submitPo', 'approvePo', 'rejectPo', 'cancelPo', 'actualize', 'closePo']) expect(moved.get(op) ?? 0, op).toBeGreaterThan(0)
  })
})
