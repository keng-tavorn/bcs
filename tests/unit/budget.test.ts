import { describe, expect, it } from 'vitest'
import { actualize, approvePo, cancelPo, closePo, emptyLine, fund, rejectPo, release, reserve, submitPo, type BudgetResult, type LineState } from '@/core/budget'

// The ledger engine's refusals and edges beyond the golden cases (spec §7.7, BR-BUD-02, BR-BUD-05, BR-BUD-06,
// BR-BUD-08): every refusal names its reason and leaves the line untouched. Amounts in satang.

const state = (r: BudgetResult): LineState => {
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`)
  return r.state
}
const funded = (amount: bigint, status: LineState['status'] = 'OPEN') => ({ ...state(fund(emptyLine(), amount, 'I')), status })
const bucketsOf = (s: LineState) => [s.buckets.available, s.buckets.reserved, s.buckets.committed, s.buckets.actual]

describe('[FR-BUD-002/AC1] the ledger engine refuses what would break the budget', () => {
  it('funds only amounts above zero, and a new line starts empty and open', () => {
    expect(emptyLine()).toMatchObject({ status: 'OPEN', funded: 0n })
    expect(emptyLine('FROZEN').status).toBe('FROZEN')
    expect(fund(emptyLine(), 0n, 'I')).toEqual({ ok: false, error: { code: 'VALIDATION_FAILED', reason: 'AMOUNT_NOT_POSITIVE' } })
    const s = funded(1_000n)
    expect(s.funded).toBe(1_000n)
    expect(fund(s, 1n, 'I2')).toMatchObject({ ok: true, movements: [{ from: 'OUTSIDE', to: 'AVAILABLE', amount: 1n, sourceType: 'IMPORT', sourceId: 'I2' }] })
  })

  it('reserves all request lines against their total, or none (BR-BUD-02), and never on a frozen or closed line (BR-BUD-08)', () => {
    const s = funded(1_000n)
    expect(reserve(s, [{ requestLineId: 'a', amount: 600n }, { requestLineId: 'b', amount: 500n }])).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', available: 1_000n, shortfall: 100n } })
    expect(reserve(s, [{ requestLineId: 'a', amount: 0n }])).toMatchObject({ ok: false, error: { reason: 'AMOUNT_NOT_POSITIVE' } })
    expect(reserve(funded(1_000n, 'FROZEN'), [{ requestLineId: 'a', amount: 1n }])).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'FROZEN' } })
    const both = state(reserve(s, [{ requestLineId: 'a', amount: 600n }, { requestLineId: 'b', amount: 400n }]))
    expect(bucketsOf(both)).toEqual([0n, 1_000n, 0n, 0n])
    expect(both.allocations['REQUEST_LINE:a']).toEqual({ reserved: 600n, committed: 0n, actual: 0n })
  })

  it('releases what request lines hold and nothing for lines that hold nothing', () => {
    const s = state(reserve(funded(1_000n), [{ requestLineId: 'a', amount: 300n }]))
    const r = release(s, ['a', 'missing'])
    expect(r).toMatchObject({ ok: true, movements: [{ from: 'RESERVED', to: 'AVAILABLE', amount: 300n, sourceId: 'a' }] })
    expect(bucketsOf(state(r))).toEqual([1_000n, 0n, 0n, 0n])
  })

  it('reserves the delta of a dearer PO only while the line is open and has it (BR-BUD-05, BR-BUD-08)', () => {
    const s = state(reserve(funded(1_000n), [{ requestLineId: 'a', amount: 900n }]))
    const po = { poLineId: 'p', need: 1_000n, sources: [{ requestLineId: 'a', releasable: 900n }] }
    expect(submitPo(s, po)).toEqual({ ok: true, state: expect.anything(), movements: [{ from: 'AVAILABLE', to: 'RESERVED', amount: 100n, sourceType: 'PO_LINE', sourceId: 'p' }] })
    expect(submitPo(s, { ...po, need: 1_200n })).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', available: 100n, shortfall: 200n } })
    expect(submitPo({ ...s, status: 'CLOSED' }, po)).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'CLOSED' } })
    // A cheaper PO reserves nothing, even on a frozen line: it only uses what its request line holds
    expect(submitPo({ ...s, status: 'FROZEN' }, { ...po, need: 800n })).toMatchObject({ ok: true, movements: [] })
  })

  it('approves a PO only for amounts above zero and within what its request lines hold', () => {
    const s = state(reserve(funded(1_000n), [{ requestLineId: 'a', amount: 500n }]))
    expect(approvePo(s, { poLineId: 'p', need: 0n, sources: [] })).toMatchObject({ ok: false, error: { reason: 'AMOUNT_NOT_POSITIVE' } })
    expect(approvePo(s, { poLineId: 'p', need: 400n, sources: [{ requestLineId: 'a', releasable: 600n }] })).toMatchObject({ ok: false, error: { reason: 'RELEASABLE_EXCEEDS_RESERVED' } })
    // A source that gives nothing back is skipped; the PO holds its amount from what is available
    const r = approvePo(s, { poLineId: 'p', need: 400n, sources: [{ requestLineId: 'a', releasable: 0n }] })
    expect(r).toMatchObject({ ok: true, movements: [{ from: 'AVAILABLE', to: 'COMMITTED', amount: 400n }] })
    expect(bucketsOf(state(r))).toEqual([100n, 500n, 400n, 0n])
    // A PO that grew after it was submitted, beyond what is left, is refused
    expect(approvePo(s, { poLineId: 'p', need: 1_200n, sources: [{ requestLineId: 'a', releasable: 500n }] })).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', available: 1_000n, shortfall: 200n } })
  })

  it('a rejected PO with no delta gives back nothing', () => {
    expect(rejectPo(funded(10n), 'p')).toMatchObject({ ok: true, movements: [] })
  })

  it('cancels a PO: an invoiced one never; one only submitted gives back its delta; returning to the pool may fail as a whole', () => {
    const s = state(reserve(funded(1_000n), [{ requestLineId: 'a', amount: 500n }]))
    const po = { poLineId: 'p', need: 600n, sources: [{ requestLineId: 'a', releasable: 500n }] }
    const submitted = state(submitPo(s, po))
    // Only submitted: the delta goes back and the request line keeps what it holds
    const cancelledEarly = state(cancelPo(submitted, po, 'RETURN_TO_POOL'))
    expect(bucketsOf(cancelledEarly)).toEqual([500n, 500n, 0n, 0n])
    const approved = state(approvePo(submitted, po))
    expect(bucketsOf(approved)).toEqual([400n, 0n, 600n, 0n])
    expect(bucketsOf(state(cancelPo(approved, po, 'CANCEL_REQUEST_LINES')))).toEqual([1_000n, 0n, 0n, 0n])
    expect(bucketsOf(state(cancelPo(approved, { ...po, sources: [{ requestLineId: 'a', releasable: 0n }] }, 'RETURN_TO_POOL')))).toEqual([1_000n, 0n, 0n, 0n])
    expect(cancelPo({ ...approved, status: 'FROZEN' }, po, 'RETURN_TO_POOL')).toEqual({ ok: false, error: { code: 'BUDGET_LINE_CLOSED', status: 'FROZEN' } })
    // A PO cheaper than what its request line gave back, then someone else used the money: returning to the pool
    // needs the full 500 the line gave back, only 400 comes free, so it fails and nothing moves
    const cheap = { poLineId: 'c', need: 400n, sources: [{ requestLineId: 'a', releasable: 500n }] }
    const cheapApproved = state(approvePo(state(submitPo(s, cheap)), cheap))
    expect(bucketsOf(cheapApproved)).toEqual([600n, 0n, 400n, 0n])
    const usedUp = state(reserve(cheapApproved, [{ requestLineId: 'z', amount: 600n }]))
    expect(cancelPo(usedUp, cheap, 'RETURN_TO_POOL')).toEqual({ ok: false, error: { code: 'BUDGET_INSUFFICIENT', available: 400n, shortfall: 100n } })
    const invoiced = state(actualize(approved, 'p', 100n))
    expect(cancelPo(invoiced, po, 'CANCEL_REQUEST_LINES')).toMatchObject({ ok: false, error: { reason: 'PO_INVOICED' } })
  })

  it('actualizes only amounts above zero and within what the PO line holds; closing keeps what is asked to wait for its invoice', () => {
    const s = state(approvePo(state(reserve(funded(1_000n), [{ requestLineId: 'a', amount: 500n }])), { poLineId: 'p', need: 500n, sources: [{ requestLineId: 'a', releasable: 500n }] }))
    expect(actualize(s, 'p', 0n)).toMatchObject({ ok: false, error: { reason: 'AMOUNT_NOT_POSITIVE' } })
    expect(actualize(s, 'p', 501n)).toEqual({ ok: false, error: { code: 'INVOICE_EXCEEDS_COMMITTED', remaining: 500n } })
    expect(bucketsOf(state(closePo(s, 'p')))).toEqual([1_000n, 0n, 0n, 0n])
    expect(bucketsOf(state(closePo(s, 'p', 200n)))).toEqual([800n, 0n, 200n, 0n])
    expect(bucketsOf(state(closePo(s, 'p', -5n)))).toEqual([1_000n, 0n, 0n, 0n])
    expect(closePo(s, 'p', 800n)).toMatchObject({ ok: true, movements: [] })
  })
})
