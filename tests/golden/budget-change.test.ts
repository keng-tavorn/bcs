import { describe, expect, it } from 'vitest'
import {
  actualize,
  allocationKey,
  approvePo,
  closePo,
  consumeOverrun,
  earmarkOverrun,
  emptyLine,
  fund,
  lapseOverrun,
  netReturned,
  overrunDoaInput,
  release,
  releaseTransfer,
  reserve,
  reserveTransfer,
  returnAfterUse,
  transferDoaInput,
  transferIn,
  transferOut,
  type BudgetResult,
  type LineState,
  type Movement,
  type TransferKind,
} from '@/core/budget'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml } from './doa-fixtures'

// tests/golden/budget-change.yaml (spec §7.17): GC-BUD-08 to GC-BUD-14 — transfers and adjustments (BR-BUD-09 to
// BR-BUD-11) on two lines A and B of one fiscal year, step by step, with INV-BUD-01 after every step; GC-BUD-15 to
// GC-BUD-24 — over-budget approval (S6-16 · BR-BUD-12 to BR-BUD-15, BR-BUD-18): earmark, use at submit, lapse, and the
// return after use of what a command gives back of the request. The split cases of S6-17 join this file with their own ops.

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
  const cases = suite.cases.filter((c) => (c.fn ? c.fn === 'transferDoaInput' : c.steps!.every((s) => TRANSFER_OPS.has(s.op))))
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

interface OverrunStep {
  op: string
  id?: string
  line?: 'A' | 'B'
  amount?: string
  source?: string
  request?: string
  need?: string
  expectShortfall?: string
  po?: string
  release?: string
  hold?: string
  actual?: string
  expectError?: string
  shortfall?: string
  expect?: Record<string, unknown>
}
interface OverrunCase {
  id: string
  title?: string
  fn?: string
  steps?: OverrunStep[]
  input?: { requestNet: string; line: { department: string; available: string }; requester: string }
  expect?: Record<string, unknown>
}

const OVERRUN_OPS = new Set(['fund', 'reserve', 'release', 'approveOverrun', 'consumeOverrun', 'lapseOverrun', 'approvePo', 'closePo'])

describe('[FR-BUD-101/AC1] [FR-BUD-101/AC2] golden budget-change.yaml: over-budget approval', () => {
  const cases = (suite.cases as OverrunCase[]).filter((c) => c.fn === 'overrunDoaInput' || (c.steps ?? []).some((s) => s.op.endsWith('Overrun')))
  it('has the cases of S6-16', () => expect(cases.map((c) => c.id)).toEqual(['GC-BUD-15', 'GC-BUD-16', 'GC-BUD-17', 'GC-BUD-18', 'GC-BUD-19', 'GC-BUD-20', 'GC-BUD-21', 'GC-BUD-22', 'GC-BUD-23', 'GC-BUD-24']))
  for (const c of cases) {
    it(`[${c.id}] ${c.title ?? c.fn}`, () => {
      if (c.fn === 'overrunDoaInput') {
        const i = c.input!
        const r = overrunDoaInput({ needSatang: amountToSatang(i.requestNet), availableSatang: amountToSatang(i.line.available), lineDepartmentId: i.line.department, requesterMemberId: i.requester })
        if (!r.ok) expect({ error: r.error.code, reason: 'reason' in r.error ? r.error.reason : null }).toEqual(c.expect)
        else expect({ documentType: r.input.documentType, net: satangToAmount(r.input.amount.netSatang), vat: satangToAmount(r.input.amount.vatSatang), department: r.input.chargedDepartmentId, conflict: r.input.conflictMemberIds }).toEqual(c.expect)
        return
      }
      expect(c.steps!.every((s) => OVERRUN_OPS.has(s.op))).toBe(true)
      const lines: Record<'A' | 'B', LineState> = { A: emptyLine(), B: emptyLine() }
      const overruns = new Map<string, { request: string; line: 'A' | 'B'; used: bigint; returned: bigint; afterUse: bigint; seq: number }>()
      const poRequest = new Map<string, string>()
      let seq = 0
      /** BR-BUD-18 after one command on a line: what it gave back of each request leaves the line, up to what is outstanding */
      const afterUse = (line: 'A' | 'B', movements: readonly Movement[]) => {
        for (const request of new Set([...overruns.values()].filter((o) => o.line === line && o.seq > 0).map((o) => o.request))) {
          const keys = new Set([allocationKey('REQUEST_LINE', request), ...[...poRequest].filter(([, r]) => r === request).map(([po]) => allocationKey('PO_LINE', po))])
          const open = [...overruns].filter(([, o]) => o.request === request && o.line === line && o.seq > 0).sort(([, a], [, b]) => b.seq - a.seq)
          const r = returnAfterUse(lines[line], netReturned(movements, keys), open.map(([id, o]) => ({ id, outstanding: o.used - o.afterUse })))
          lines[line] = r.state
          for (const [id, s] of r.returned) overruns.get(id)!.afterUse += s
        }
      }
      for (const s of c.steps!) {
        let error: { code: string; shortfall?: bigint } | null = null
        let current: { used: bigint; returned: bigint } | null = null
        const line = s.line ?? 'A'
        const apply = (r: BudgetResult) => {
          if (!r.ok) return r.error
          lines[line] = r.state
          return null
        }
        if (s.op === 'fund') error = apply(fund(lines[line], amountToSatang(s.amount!), `import-${c.id}`))
        if (s.op === 'reserve') error = apply(reserve(lines[line], [{ requestLineId: s.source!, amount: amountToSatang(s.amount!) }]))
        if (s.op === 'release') {
          const r = release(lines[line], [s.source!])
          error = apply(r)
          if (r.ok) afterUse(line, r.movements)
        }
        if (s.op === 'approveOverrun') {
          const doa = overrunDoaInput({ needSatang: amountToSatang(s.need!), availableSatang: lines[line].buckets.available, lineDepartmentId: 'CON', requesterMemberId: 'u1' })
          expect(doa.ok).toBe(true)
          const x = doa.ok ? doa.input.amount.netSatang : 0n
          if (s.expectShortfall) expect(satangToAmount(x)).toBe(s.expectShortfall)
          error = apply(earmarkOverrun(lines[line], s.id!, x))
          overruns.set(s.id!, { request: s.request!, line, used: 0n, returned: 0n, afterUse: 0n, seq: 0 })
        }
        if (s.op === 'consumeOverrun') {
          const o = overruns.get(s.id!)!
          const r = consumeOverrun(lines[o.line], s.id!, [{ requestLineId: o.request, amount: amountToSatang(s.need!) }])
          if (r.ok) {
            lines[o.line] = r.state
            Object.assign(o, { used: r.used, returned: r.returned, seq: ++seq })
            current = o
          } else error = r.error
        }
        if (s.op === 'lapseOverrun') {
          const o = overruns.get(s.id!)!
          const r = lapseOverrun(lines[o.line], s.id!)
          lines[o.line] = r.state
          Object.assign(o, { used: r.used, returned: r.returned })
          current = o
        }
        if (s.op === 'approvePo') {
          poRequest.set(s.po!, s.request!)
          const r = approvePo(lines[line], { poLineId: s.po!, need: amountToSatang(s.hold!), sources: [{ requestLineId: s.request!, releasable: amountToSatang(s.release!) }] })
          error = apply(r)
          if (r.ok) afterUse(line, r.movements)
        }
        if (s.op === 'closePo') {
          // The last invoice (COMMITTED → ACTUAL) and the close (COMMITTED → AVAILABLE) are one command
          const invoiced = actualize(lines[line], s.po!, amountToSatang(s.actual!))
          expect(apply(invoiced)).toBeNull()
          const closed = closePo(lines[line], s.po!)
          expect(apply(closed)).toBeNull()
          if (invoiced.ok && closed.ok) afterUse(line, [...invoiced.movements, ...closed.movements])
        }
        if (s.expectError) {
          expect(error?.code).toBe(s.expectError)
          if (s.shortfall) expect(satangToAmount(error!.shortfall!)).toBe(s.shortfall)
        } else expect(error).toBeNull()
        for (const [key, exp] of Object.entries(s.expect ?? {})) {
          if (key === 'A' || key === 'B') expect(view(lines[key])).toMatchObject(exp as object)
          else if (key === 'used' || key === 'returned') expect(satangToAmount(current![key])).toBe(exp)
          else if (key === 'returnedAfterUse') expect(satangToAmount([...overruns.values()].reduce((a, o) => a + o.afterUse, 0n))).toBe(exp)
          else throw new Error(`unknown expect ${key}`)
        }
        for (const l of Object.values(lines)) {
          expect(l.buckets.available + l.buckets.reserved + l.buckets.committed + l.buckets.actual).toBe(l.funded)
          for (const v of Object.values(l.buckets)) expect(v >= 0n).toBe(true)
        }
      }
    })
  }
})
