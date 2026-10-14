import { describe, expect, it } from 'vitest'
import { emptyLine, fund, releaseTransfer, reserveTransfer, transferDoaInput, transferIn, transferOut, type BudgetResult, type LineState, type TransferKind } from '@/core/budget'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml } from './doa-fixtures'

// tests/golden/budget-change.yaml (spec §7.17): GC-BUD-08 to GC-BUD-14 — transfers and adjustments (BR-BUD-09 to
// BR-BUD-11) on two lines A and B of one fiscal year, step by step, with INV-BUD-01 after every step. The overrun and
// split cases of S6-16 and S6-17 join this file with their own ops.

interface Step {
  op: string
  id?: string
  line?: 'A' | 'B'
  kind?: TransferKind
  from?: 'A' | 'B'
  to?: 'A' | 'B'
  amount?: string
  expectError?: string
  shortfall?: string
  expect?: Partial<Record<'A' | 'B', Partial<Record<'available' | 'reserved' | 'committed' | 'actual' | 'funded', string>>>>
}
interface BudgetCase {
  id: string
  title?: string
  fn?: string
  steps?: Step[]
  input?: { kind: TransferKind; from?: { department: string }; to?: { department: string }; amount: string; submitter: string }
  expect?: Record<string, unknown>
}

const suite = loadYaml<{ cases: BudgetCase[] }>('budget-change.yaml')
const TRANSFER_OPS = new Set(['fund', 'submitTransfer', 'approveTransfer', 'rejectTransfer'])

function view(s: LineState) {
  return { available: satangToAmount(s.buckets.available), reserved: satangToAmount(s.buckets.reserved), committed: satangToAmount(s.buckets.committed), actual: satangToAmount(s.buckets.actual), funded: satangToAmount(s.funded) }
}

describe('[FR-BUD-103/AC1] [FR-BUD-103/AC2] golden budget-change.yaml: transfers and adjustments', () => {
  const cases = suite.cases.filter((c) => c.fn === 'transferDoaInput' || (c.steps ?? []).every((s) => TRANSFER_OPS.has(s.op)))
  it('has the cases of S6-15', () => expect(cases.map((c) => c.id)).toEqual(['GC-BUD-08', 'GC-BUD-09', 'GC-BUD-10', 'GC-BUD-11', 'GC-BUD-12', 'GC-BUD-13', 'GC-BUD-14']))
  for (const c of cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => {
      if (c.fn === 'transferDoaInput') {
        const i = c.input!
        const r = transferDoaInput({ kind: i.kind, fromDepartmentId: i.from?.department ?? null, toDepartmentId: i.to?.department ?? null, amountSatang: amountToSatang(i.amount), submitterMemberId: i.submitter })
        expect({ documentType: r.documentType, net: satangToAmount(r.amount.netSatang), vat: satangToAmount(r.amount.vatSatang), department: r.chargedDepartmentId, conflict: r.conflictMemberIds }).toEqual(c.expect)
        return
      }
      const lines: Record<'A' | 'B', LineState> = { A: emptyLine(), B: emptyLine() }
      const transfers = new Map<string, { kind: TransferKind; from?: 'A' | 'B'; to?: 'A' | 'B'; amount: bigint }>()
      const apply = (line: 'A' | 'B', r: BudgetResult) => {
        if (!r.ok) return r.error
        lines[line] = r.state
        return null
      }
      for (const s of c.steps!) {
        let error: { code: string; shortfall?: bigint } | null = null
        if (s.op === 'fund') error = apply(s.line!, fund(lines[s.line!], amountToSatang(s.amount!), `import-${c.id}`))
        if (s.op === 'submitTransfer') {
          const t = { kind: s.kind ?? 'TRANSFER', ...(s.from ? { from: s.from } : {}), ...(s.to ? { to: s.to } : {}), amount: amountToSatang(s.amount!) }
          error = t.kind === 'INCREASE' ? null : apply(t.from!, reserveTransfer(lines[t.from!], s.id!, t.amount))
          if (!error) transfers.set(s.id!, t)
        }
        if (s.op === 'approveTransfer') {
          const t = transfers.get(s.id!)!
          if (t.kind !== 'INCREASE') expect(apply(t.from!, transferOut(lines[t.from!], s.id!))).toBeNull()
          if (t.kind !== 'DECREASE') expect(apply(t.to!, transferIn(lines[t.to!], s.id!, t.amount))).toBeNull()
        }
        if (s.op === 'rejectTransfer') {
          const t = transfers.get(s.id!)!
          if (t.from) expect(apply(t.from, releaseTransfer(lines[t.from], s.id!))).toBeNull()
        }
        if (s.expectError) {
          expect(error?.code).toBe(s.expectError)
          if (s.shortfall) expect(satangToAmount(error!.shortfall!)).toBe(s.shortfall)
        } else expect(error).toBeNull()
        for (const [line, exp] of Object.entries(s.expect ?? {})) expect(view(lines[line as 'A' | 'B'])).toMatchObject(exp!)
        // INV-BUD-01 · INV-BUD-07 after every step
        for (const l of Object.values(lines)) expect(l.buckets.available + l.buckets.reserved + l.buckets.committed + l.buckets.actual).toBe(l.funded)
      }
    })
  }
})
