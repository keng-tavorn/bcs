import { describe, expect, it } from 'vitest'
import { chooseRule } from '@/core/doa'
import { checkDuplicates, type DupRecent } from '@/core/duplicates'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { loadYaml, versionSnapshots } from './doa-fixtures'

// tests/golden/duplicates.yaml (spec §7.17): GC-DUP-01 to GC-DUP-13 — duplicate requests and split purchases (BR-DUP-01
// to BR-DUP-04) under DOA-DEMO version 1 of the fixture (its basis is GROSS, as the amounts of the cases are).

interface Req {
  ref?: string
  requester?: string
  department?: string
  supplier?: string
  status?: string
  submittedAt?: string
  amount: string
  lines: Array<{ d: string; uom: string; qty: string }>
}
interface DupSuite {
  fixtures: string[]
  policy: { windowDays: number }
  defaults: { at: string; requester: string; department: string; supplier: string }
  cases: Array<{ id: string; title?: string; input: { at?: string; candidate: Req; recent: Req[] }; expect: { flags: Array<Record<string, unknown>> } }>
}

const suite = loadYaml<DupSuite>('duplicates.yaml')
const version = versionSnapshots(suite.fixtures.find((f) => f.includes('doa-versions')))[0]!

describe('[FR-INT-103/AC1] golden duplicates.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBe(13))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`, () => {
      const d = suite.defaults
      const at = new Date(c.input.at ?? d.at)
      const of = (r: Req, id: string) => ({
        id,
        requesterMemberId: r.requester ?? d.requester,
        chargedDepartmentId: r.department ?? d.department,
        suggestedSupplierId: r.supplier ?? d.supplier,
        basisAmountSatang: amountToSatang(r.amount),
        lines: r.lines.map((l) => ({ description: l.d, uom: l.uom, quantity: l.qty })),
      })
      const recent: DupRecent[] = c.input.recent.map((r) => ({ ...of(r, r.ref!), status: r.status!, submittedAt: new Date(r.submittedAt!) }))
      const ruleFor = (amount: bigint) => {
        const choice = chooseRule(version, 'PURCHASE_REQUEST', amount)
        return choice.kind === 'rule' ? choice.rule.code : null
      }
      const flags = checkDuplicates(of(c.input.candidate, 'candidate'), recent, { at, windowDays: suite.policy.windowDays, ruleFor })
      expect(
        flags.map((f) =>
          f.kind === 'DUPLICATE'
            ? { kind: f.kind, with: f.matchedRequestIds }
            : { kind: f.kind, with: f.matchedRequestIds, combined: satangToAmount(f.combinedSatang), individualRule: f.individualRule, combinedRule: f.combinedRule },
        ),
      ).toEqual(c.expect.flags)
    })
  }
})
