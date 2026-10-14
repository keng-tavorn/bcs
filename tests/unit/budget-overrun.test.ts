import { describe, expect, it } from 'vitest'
import { consumeOverrun, earmarkOverrun, emptyLine, fund, lapseOverrun, netReturned, overrunDoaInput, reserve, returnAfterUse, type LineState } from '@/core/budget'

// The edges of the over-budget operations (S6-16 · BR-BUD-12 to BR-BUD-15, BR-BUD-18) that the golden cases and the
// property test do not reach: a line that is not OPEN, amounts not above zero, an overrun with nothing earmarked, and a
// return after use bounded by what the line has available.

const funded = (amount: bigint): LineState => {
  const r = fund(emptyLine(), amount, 'IMPORT')
  if (!r.ok) throw new Error('fund')
  return r.state
}
const frozen = (s: LineState): LineState => ({ ...s, status: 'FROZEN' })

describe('[FR-BUD-101/AC1] over-budget operations refuse what does not fit', () => {
  it('earmarks only on an OPEN line and only an amount above zero', () => {
    expect(earmarkOverrun(frozen(funded(100n)), 'O1', 50n)).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'FROZEN' } })
    expect(earmarkOverrun(funded(100n), 'O1', 0n)).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' } })
  })

  it('uses an overrun only on an OPEN line, for lines above zero, with something earmarked', () => {
    const earmarked = earmarkOverrun(funded(100n), 'O1', 50n)
    if (!earmarked.ok) throw new Error('earmark')
    expect(consumeOverrun(frozen(earmarked.state), 'O1', [{ requestLineId: 'L1', amount: 150n }])).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'FROZEN' } })
    expect(consumeOverrun(earmarked.state, 'O1', [{ requestLineId: 'L1', amount: 0n }])).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' } })
    expect(consumeOverrun(earmarked.state, 'O2', [{ requestLineId: 'L1', amount: 150n }])).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', reason: 'NOTHING_RESERVED' } })
    // More than the line and the earmark together: what was there and what is missing
    expect(consumeOverrun(earmarked.state, 'O1', [{ requestLineId: 'L1', amount: 151n }])).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', available: 150n, shortfall: 1n } })
  })

  it('a lapse with nothing earmarked moves nothing', () => {
    const line = funded(100n)
    expect(lapseOverrun(line, 'O1')).toEqual({ ok: true, state: line, movements: [], used: 0n, returned: 0n })
  })

  it('the DOA input names the line owner and the requester (BR-BUD-12)', () => {
    expect(overrunDoaInput({ needSatang: 101n, availableSatang: 100n, lineDepartmentId: 'MKT', requesterMemberId: 'u1' })).toEqual({
      ok: true,
      input: { documentType: 'OVER_BUDGET', amount: { netSatang: 1n, vatSatang: 0n }, chargedDepartmentId: 'MKT', conflictMemberIds: ['u1'] },
    })
  })
})

describe('[FR-BUD-101/AC2] the return after use (BR-BUD-18)', () => {
  it('counts only the request’s own allocations, net, never below zero', () => {
    const keys = new Set(['REQUEST_LINE:L1', 'PO_LINE:P1'])
    expect(
      netReturned(
        [
          { from: 'RESERVED', to: 'AVAILABLE', amount: 100n, sourceType: 'REQUEST_LINE', sourceId: 'L1' },
          { from: 'RESERVED', to: 'AVAILABLE', amount: 70n, sourceType: 'REQUEST_LINE', sourceId: 'L9' },
          { from: 'AVAILABLE', to: 'COMMITTED', amount: 30n, sourceType: 'PO_LINE', sourceId: 'P1' },
          { from: 'COMMITTED', to: 'ACTUAL', amount: 10n, sourceType: 'PO_LINE', sourceId: 'P1' },
          { from: 'COMMITTED', to: 'AVAILABLE', amount: 5n, sourceType: 'PO_LINE', sourceId: 'P1' },
        ],
        keys,
      ),
    ).toBe(75n)
    expect(netReturned([{ from: 'AVAILABLE', to: 'RESERVED', amount: 5n, sourceType: 'REQUEST_LINE', sourceId: 'L1' }], keys)).toBe(0n)
  })

  it('returns to the overrun used last first, never more than the line has available', () => {
    const r = reserve(funded(100n), [{ requestLineId: 'L1', amount: 60n }])
    if (!r.ok) throw new Error('reserve')
    // 40 available: of 90 given back, 40 can leave — 30 to O2 (outstanding 30) then 10 to O1
    const out = returnAfterUse(r.state, 90n, [
      { id: 'O2', outstanding: 30n },
      { id: 'O1', outstanding: 50n },
      { id: 'O0', outstanding: 20n },
    ])
    expect([...out.returned]).toEqual([
      ['O2', 30n],
      ['O1', 10n],
    ])
    expect(out.state.buckets.available).toBe(0n)
    expect(out.state.funded).toBe(60n)
  })
})
