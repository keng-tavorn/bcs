import { describe, expect, it } from 'vitest'
import { actualize, approvePo, cancelPo, closePo, emptyLine, fund, rejectPo, release, reserve, submitPo, type BudgetResult, type LineState, type PoLine } from '@/core/budget'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml } from './doa-fixtures'

// tests/golden/budget.yaml (spec §7.7): GC-BUD-01 to GC-BUD-06 walk one budget line through its steps and compare the
// buckets after each step. GC-BUD-07 (kind: concurrency) runs against real Postgres in tests/integration/budget.test.ts.

interface Step {
  op: string
  amount?: string
  amounts?: string[]
  source?: string
  po?: string
  need?: string
  sources?: Array<{ source: string; releasable: string }>
  disposition?: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'
  expectError?: string
  expect?: { available: string; reserved: string; committed: string; actual: string }
}

interface BudgetSuite {
  cases: Array<{ id: string; title: string; kind?: string; steps: Step[] }>
}

const suite = loadYaml<BudgetSuite>('budget.yaml')

/** The PO lines a case submitted, so approval and cancellation see the same need and sources */
function run(steps: readonly Step[]) {
  let state: LineState = emptyLine()
  const pos = new Map<string, PoLine>()
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
      case 'release':
        result = release(state, [step.source!])
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
      case 'rejectPo':
        result = rejectPo(state, step.po!)
        break
      case 'cancelPo':
        result = cancelPo(state, pos.get(step.po!)!, step.disposition!)
        break
      case 'actualize':
        result = actualize(state, step.po!, amountToSatang(step.amount!))
        break
      case 'closePo':
        result = closePo(state, step.po!)
        break
      default:
        throw new Error(`unknown op ${step.op}`)
    }
    if (result.ok) state = result.state
    results.push({ step, result, state })
  }
  return results
}

const buckets = (s: LineState) => ({
  available: satangToAmount(s.buckets.available),
  reserved: satangToAmount(s.buckets.reserved),
  committed: satangToAmount(s.buckets.committed),
  actual: satangToAmount(s.buckets.actual),
})

describe('[FR-BUD-002/AC1] golden budget.yaml', () => {
  const sequential = suite.cases.filter((c) => c.kind !== 'concurrency')
  it('has cases', () => expect(sequential.length).toBeGreaterThan(0))

  for (const c of sequential) {
    it(`[${c.id}] ${c.title}`, () => {
      for (const { step, result, state } of run(c.steps)) {
        if (step.expectError) expect(result.ok ? 'ok' : result.error.code, `${step.op} ${step.source ?? step.po ?? ''}`).toBe(step.expectError)
        else expect(result.ok, `${step.op} ${step.source ?? step.po ?? ''}: ${result.ok ? '' : result.error.code}`).toBe(true)
        if (step.expect) expect(buckets(state), `${step.op} ${step.source ?? step.po ?? ''}`).toEqual(step.expect)
      }
    })
  }
})
