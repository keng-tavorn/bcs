import { describe, expect, it } from 'vitest'
import { precheckRun, type PrecheckFailure } from '@/core/bankfile'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml } from './doa-fixtures'

// tests/golden/bank-precheck.yaml (spec §7.14, BR-BANK-06): every case is the suite's base with its change applied
// (paths items.<index>.<field>); money as baht strings, a document HELD by this run as link HELD_BY_THIS_RUN.

interface RawAccount { bankCode: string; accountNo: string; accountName: string }
interface RawItem { seq: number; supplier: string; transfer: string; snapshot: RawAccount; register: (RawAccount & { status: string }) | null; documents: Array<{ id: string; link: string }> }
interface RawRun { totalTransfer: string; itemCount: number; payerStatus: string; payerTemplate: string; runTemplate: string }
interface PrecheckCase { id: string; title: string; change: Record<string, unknown>; expect: unknown }

const suite = loadYaml<{ base: { run: RawRun; items: RawItem[] }; cases: PrecheckCase[] }>('bank-precheck.yaml')

/** The base with each path of the change set to its value */
function applyChange<T>(base: T, change: Record<string, unknown>): T {
  const copy = structuredClone(base) as Record<string, unknown>
  for (const [path, value] of Object.entries(change)) {
    const keys = path.split('.')
    let node = copy
    for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>
    node[keys.at(-1)!] = value
  }
  return copy as T
}

function precheckOf(input: { run: RawRun; items: RawItem[] }) {
  return precheckRun(
    { totalTransferSatang: amountToSatang(input.run.totalTransfer), itemCount: input.run.itemCount, payerStatus: input.run.payerStatus, payerTemplateCode: input.run.payerTemplate, runTemplateCode: input.run.runTemplate },
    input.items.map((i) => ({ seq: i.seq, supplierCode: i.supplier, transferSatang: amountToSatang(i.transfer), snapshot: i.snapshot, register: i.register, documents: i.documents.map((d) => ({ id: d.id, heldByThisRun: d.link === 'HELD_BY_THIS_RUN' })) })),
  )
}

const asGolden = (f: PrecheckFailure) => (f.check === 'TOTAL_MISMATCH' ? { check: f.check, expected: satangToAmount(f.expectedSatang), actual: satangToAmount(f.actualSatang) } : f)

describe('golden bank-precheck.yaml', () => {
  it('has the cases of the suite', () => expect(suite.cases.length).toBe(11))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title}`, () => {
      const r = precheckOf(applyChange(suite.base, c.change))
      expect({ ok: r.ok, failures: r.failures.map(asGolden) }).toEqual(c.expect)
    })
  }
})
