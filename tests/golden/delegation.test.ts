import { describe, expect, it } from 'vitest'
import { amountToSatang } from '@/core/money/dto'
import { validateNewDelegation } from '@/core/delegation'
import { resolveRoute, type DoaDocumentType } from '@/core/doa'
import { delegationSnapshot, loadYaml, orgSnapshot, pick, versionSnapshots } from './doa-fixtures'

// tests/golden/delegation.yaml (spec §7.6): GC-DLG-01 to GC-DLG-06 through resolveRoute and validateNewDelegation.

interface DelegationSuite {
  defaults: { documentType: DoaDocumentType; requester: string; department: string }
  delegations: Record<string, { delegator: string; delegate: string; startsAt: string; endsAt: string; maxAmount?: string }>
  cases: Array<{
    id: string
    title?: string
    input?: { amount: string; at: string; active: string[]; requester?: string }
    create?: { delegator: string; delegate: string; startsAt: string; endsAt: string }
    existing?: string[]
    expect: Record<string, unknown>
  }>
}

const suite = loadYaml<DelegationSuite>('delegation.yaml')
const named = (id: string) => delegationSnapshot(id, suite.delegations[id]!)

describe('golden delegation.yaml', () => {
  it('has cases', () => expect(suite.cases.length).toBeGreaterThan(0))
  for (const c of suite.cases) {
    it(`[${c.id}] ${c.title ?? ''}`.trim(), () => {
      if (c.create) {
        const refusal = validateNewDelegation(
          { delegatorMemberId: c.create.delegator, delegateMemberId: c.create.delegate, startsAt: new Date(c.create.startsAt), endsAt: new Date(c.create.endsAt), documentTypes: null, maxAmountSatang: null },
          (c.existing ?? []).map(named),
          orgSnapshot(),
        )
        const actual = refusal ? { error: 'VALIDATION_FAILED', reason: refusal } : { ok: true }
        expect(pick(actual, c.expect)).toEqual(c.expect)
        return
      }
      const i = { ...suite.defaults, ...c.input! }
      const result = resolveRoute(
        {
          documentType: i.documentType,
          amount: { netSatang: amountToSatang(i.amount), vatSatang: 0n },
          requesterMemberId: i.requester,
          chargedDepartmentId: i.department,
          conflictMemberIds: [i.requester],
          at: new Date(i.at),
        },
        { versions: versionSnapshots(), org: orgSnapshot(), delegations: i.active.map(named) },
      )
      if (!result.ok) throw new Error(`route failed: ${result.error.code}`)
      const step = result.data.steps[0]!
      const actual = { assignee: step.assigneeMemberId, principal: step.principalMemberId, notifyOrgAdmin: step.notifyOrgAdmin }
      expect(pick(actual, c.expect)).toEqual(c.expect)
    })
  }
})
