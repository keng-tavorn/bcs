import { describe, expect, it } from 'vitest'
import { allocationKey, approvePo, emptyLine, fund, reserve, submitPo, type BudgetResult, type LineState, type PoLine } from '@/core/budget'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { approveChange, changeTotals, rejectChange, submitChange, type ChangeBudgetLine } from '@/core/po-change'
import { loadYaml, pick } from './doa-fixtures'

// tests/golden/po-change.yaml (spec ADR-125, BR-POC-01 to BR-POC-03): a change to an approved PO walked on one budget
// line with the PO functions of src/core/budget (fund reserve submitPo approvePo as in budget.yaml, then submitChange
// approveChange rejectChange of src/core/po-change), and changeTotals: the new totals, the DOA amount and the refusals.

type Raw = Record<string, unknown>
interface Step {
  op: string
  amount?: string
  source?: string
  po?: string
  need?: string
  sources?: Array<{ source: string; releasable: string }>
  newNet?: string
  addedReleasable?: string
  disposition?: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'
  removedReleasable?: string
  expectError?: string
  expect?: { available: string; reserved: string; committed: string; actual: string }
}
interface PoChangeCase { id: string; title: string; fn?: 'changeTotals'; steps?: Step[]; input?: Raw; expect?: Raw }

const suite = loadYaml<{ cases: PoChangeCase[] }>('po-change.yaml')

function walk(steps: readonly Step[]) {
  let state: LineState = emptyLine()
  const pos = new Map<string, PoLine>()
  const changes = new Map<string, ChangeBudgetLine>()
  const results: Array<{ step: Step; result: BudgetResult; state: LineState }> = []
  for (const step of steps) {
    let result: BudgetResult
    switch (step.op) {
      case 'fund':
        result = fund(state, amountToSatang(step.amount!), 'IMPORT-1')
        break
      case 'reserve':
        result = reserve(state, [{ requestLineId: step.source!, amount: amountToSatang(step.amount!) }])
        break
      case 'submitPo': {
        const po: PoLine = { poLineId: step.po!, need: amountToSatang(step.need!), sources: step.sources!.map((s) => ({ requestLineId: s.source, releasable: amountToSatang(s.releasable) })) }
        pos.set(step.po!, po)
        result = submitPo(state, po)
        break
      }
      case 'approvePo':
        result = approvePo(state, pos.get(step.po!)!)
        break
      case 'submitChange': {
        const held = state.allocations[allocationKey('PO_LINE', step.po!)]?.committed ?? 0n
        const line: ChangeBudgetLine = { poLineId: step.po!, requestLineId: pos.get(step.po!)!.sources[0]!.requestLineId, deltaSatang: amountToSatang(step.newNet!) - held, addedReleasableSatang: amountToSatang(step.addedReleasable!) }
        result = submitChange(state, line)
        if (result.ok) changes.set(step.po!, line)
        break
      }
      case 'approveChange':
        result = approveChange(state, changes.get(step.po!)!, step.disposition ? { disposition: step.disposition, removedReleasableSatang: amountToSatang(step.removedReleasable!) } : null)
        break
      case 'rejectChange':
        result = rejectChange(state, step.po!)
        break
      default:
        throw new Error(`unknown op ${step.op}`)
    }
    if (result.ok) state = result.state
    results.push({ step, result, state })
  }
  return results
}

const buckets = (s: LineState) => ({ available: satangToAmount(s.buckets.available), reserved: satangToAmount(s.buckets.reserved), committed: satangToAmount(s.buckets.committed), actual: satangToAmount(s.buckets.actual) })

function totals(input: Raw): Raw {
  const i = input as { vatRateBp: number; line: { ordered: string; received: string; invoiced: string; requestLeft: string; unitPrice?: string }; change: { newQty?: string; newUnitPrice?: string } }
  const r = changeTotals(
    [
      {
        ordered: i.line.ordered,
        received: i.line.received,
        invoiced: i.line.invoiced,
        requestLeft: i.line.requestLeft,
        // the cases name no current price: a newUnitPrice is a price the change asks for (GC-POC-11 on an invoiced line)
        unitPriceSatang: amountToSatang(i.line.unitPrice ?? '0.00'),
        vatable: true,
        change: { ...(i.change.newQty !== undefined ? { newQty: i.change.newQty } : {}), ...(i.change.newUnitPrice !== undefined ? { newUnitPriceSatang: amountToSatang(i.change.newUnitPrice) } : {}) },
      },
    ],
    i.vatRateBp,
  )
  if (!r.ok) return r.code === 'PO_CHANGE_EXCEEDS_REQUEST' ? { error: r.code, left: r.left } : { error: r.code, reason: r.reason }
  const net = satangToAmount(r.netSatang)
  const vat = satangToAmount(r.vatSatang)
  return { net, vat, gross: satangToAmount(r.grossSatang), doaAmount: { net, vat } }
}

describe('[FR-AP-107/AC1] golden po-change.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      if (c.fn === 'changeTotals') {
        const actual = totals(c.input!)
        expect(pick(actual, c.expect!)).toEqual(c.expect)
        expect(Object.keys(actual).sort()).toEqual(Object.keys(c.expect!).sort())
        return
      }
      for (const { step, result, state } of walk(c.steps!)) {
        expect(result.ok ? undefined : result.error.code, `${step.op} error`).toBe(step.expectError)
        if (step.expect) expect(buckets(state), `after ${step.op}`).toEqual(step.expect)
        // INV-BUD-01: the buckets add up to what was funded after every step
        expect(state.buckets.available + state.buckets.reserved + state.buckets.committed + state.buckets.actual).toBe(state.funded)
      }
    })
  }
})

/** A budget line funded with `amount` whose PO line L holds `held` */
function approved(amount: bigint, held: bigint): LineState {
  const funded = fund(emptyLine(), amount, 'I')
  if (!funded.ok) throw new Error('fund')
  const po = approvePo(funded.state, { poLineId: 'L', need: held, sources: [] })
  if (!po.ok) throw new Error('approvePo')
  return po.state
}

describe('po-change beyond the golden cases', () => {
  const line = { ordered: '10', received: '0', invoiced: '4', requestLeft: '2', unitPriceSatang: 100_000n, vatable: false }
  const decrease = { poLineId: 'L', requestLineId: 'R', deltaSatang: -100_000n, addedReleasableSatang: 0n }

  it('refuses below what was invoiced; totals two lines with a line that is not VAT-able', () => {
    expect(changeTotals([{ ...line, change: { newQty: '3' } }], 700)).toMatchObject({ ok: false, code: 'PO_CHANGE_BELOW_PROGRESS', reason: 'INVOICED', line: 1 })
    const r = changeTotals([{ ...line, received: '4', invoiced: '0', change: { newQty: '12' } }, { ...line, invoiced: '0', vatable: true }], 700)
    expect(r).toMatchObject({ ok: true, netSatang: 2_200_000n, vatSatang: 70_000n, grossSatang: 2_270_000n, lines: [{ quantity: '12' }, { quantity: '10' }] })
  })

  it('a decrease cancels in the request or returns to the pool; no change moves nothing; the pool needs the budget again', () => {
    const s = approved(1_000_000n, 500_000n)
    const cut = approveChange(s, decrease, { disposition: 'CANCEL_REQUEST_LINES', removedReleasableSatang: 100_000n })
    expect(cut.ok && cut.state.buckets).toMatchObject({ available: 600_000n, committed: 400_000n })
    const pool = approveChange(s, decrease, { disposition: 'RETURN_TO_POOL', removedReleasableSatang: 100_000n })
    expect(pool.ok && pool.state.buckets).toMatchObject({ available: 500_000n, reserved: 100_000n, committed: 400_000n })
    expect(approveChange(s, { ...decrease, deltaSatang: 0n }, null)).toMatchObject({ ok: true, movements: [] })
    expect(submitChange(s, { ...decrease, deltaSatang: -1n })).toMatchObject({ ok: true, movements: [] })
    expect(approveChange(approved(500_000n, 500_000n), decrease, { disposition: 'RETURN_TO_POOL', removedReleasableSatang: 200_000n })).toMatchObject({ ok: false, error: { code: 'BUDGET_INSUFFICIENT' } })
  })
})
