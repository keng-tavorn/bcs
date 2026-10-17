import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resolveRoute, type DelegationSnapshot, type DoaDocumentType, type DoaVersionSnapshot, type RouteInput } from '@/core/doa'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'
import { resolveRoute as resolveRouteBeforeS6 } from '../support/doa-pre-s6/resolve-route'

// INV-WF-01 (spec §7.17, S6-02): a DOA without PARALLEL steps routes every document exactly as before S6. The engine
// with committees is compared with a frozen copy of the engine of before S6 (tests/support/doa-pre-s6) on 1,000
// random documents of the demo and phase-1 fixtures: every field of the route (but ruleStepNo, which it never had), or
// the same refusal.

const FIXTURES = [
  { org: 'fixtures/org-demo.yaml', versions: 'fixtures/doa-versions.yaml' },
  { org: 'fixtures/org-p1.yaml', versions: 'fixtures/doa-versions-p1.yaml' },
] as const
const TYPES: readonly DoaDocumentType[] = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE', 'BUDGET_TRANSFER', 'OVER_BUDGET', 'INVOICE_EXCEPTION', 'PO_CHANGE', 'PAYMENT_RUN', 'BANK_ACCOUNT_CHANGE']
const MEMBERS = ['req_con', 'asst_con', 'dm_con', 'dm_proc', 'dm_fin', 'dm_it', 'vp_ops', 'vp_sup', 'coo', 'cfo', 'ceo', 'admin', 'proc_officer'] as const
const DEPARTMENTS = ['CON', 'PROC', 'FIN', 'IT', 'OPS', 'SUP', 'HQ'] as const
const POSITIONS = ['DM@CON', 'DM@PROC', 'DM@FIN', 'DM@IT', 'VP@OPS', 'VP@SUP', 'COO@HQ', 'CFO@HQ', 'CEO@HQ', 'PROC_MGR@HQ'] as const

const caseArb = fc.record({
  fixture: fc.constantFrom(0, 1),
  documentType: fc.constantFrom(...TYPES),
  // up to 3,000,000.00 baht with odd satang, or no amount at all
  amount: fc.option(fc.record({ net: fc.bigInt({ min: 0n, max: 300_000_000n }), vat: fc.bigInt({ min: 0n, max: 21_000_000n }) }), { nil: undefined }),
  requester: fc.constantFrom(...MEMBERS),
  department: fc.constantFrom(...DEPARTMENTS),
  alsoConflicting: fc.subarray([...MEMBERS], { maxLength: 3 }),
  vacate: fc.subarray([...POSITIONS], { maxLength: 2 }),
  delegations: fc.array(fc.record({ from: fc.constantFrom(...MEMBERS), to: fc.constantFrom(...MEMBERS), cap: fc.option(fc.bigInt({ min: 1n, max: 50_000_000n }), { nil: null }) }), { maxLength: 2 }),
  // October and November 2026: both demo versions take turns
  at: fc.integer({ min: Date.parse('2026-10-01T00:00:00Z'), max: Date.parse('2026-11-30T00:00:00Z') }),
  amountBasis: fc.constantFrom<'GROSS' | 'NET' | undefined>('GROSS', 'NET', undefined),
  collapse: fc.boolean(),
  block: fc.boolean(),
})

describe('[FR-WF-102/AC4] [INV-WF-01] the engine with committees routes a DOA without them as the engine of before S6', () => {
  const versions = FIXTURES.map((f) => versionSnapshots(f.versions))
  it('1,000 random documents: the same route in every field, or the same refusal', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const f = FIXTURES[c.fixture]!
        const vs: DoaVersionSnapshot[] = versions[c.fixture]!.map((v) => ({
          ...v,
          ...(c.amountBasis ? { amountBasis: c.amountBasis } : {}),
          collapseDuplicateApprovers: c.collapse,
          selfApprovalPolicy: c.block ? 'BLOCK' : 'ESCALATE_NEXT_BAND',
        }))
        const delegations: DelegationSnapshot[] = c.delegations.map((d, i) => ({
          id: `D${i}`,
          delegatorMemberId: d.from,
          delegateMemberId: d.to,
          startsAt: new Date('2026-09-01T00:00:00Z'),
          endsAt: new Date('2026-12-31T00:00:00Z'),
          documentTypes: null,
          maxAmountSatang: d.cap,
          status: 'ACTIVE',
        }))
        const input: RouteInput = {
          documentType: c.documentType,
          ...(c.amount ? { amount: { netSatang: c.amount.net, vatSatang: c.amount.vat } } : {}),
          requesterMemberId: c.requester,
          chargedDepartmentId: c.department,
          conflictMemberIds: [c.requester, ...c.alsoConflicting],
          at: new Date(c.at),
        }
        const policy = { versions: vs, org: orgSnapshot([...c.vacate], f.org), delegations }
        // The fixtures have no committee, so their versions are versions of the old engine too. ruleStepNo (the step's place
        // in the rule, added by the ADR-073 pre-review for doaStepNo) is the only field the old engine never had: it is
        // taken out for the comparison and checked on its own — rising with the route, never before the step's place on it
        const now = resolveRoute(input, policy)
        const before = resolveRouteBeforeS6(input, policy as Parameters<typeof resolveRouteBeforeS6>[1])
        if (now.ok) {
          const places = now.data.steps.map((s) => s.ruleStepNo)
          expect(places.every((p, i) => p >= i + 1 && (i === 0 || p > places[i - 1]!))).toBe(true)
        }
        const withoutPlaces = now.ok ? { ...now, data: { ...now.data, steps: now.data.steps.map(({ ruleStepNo: _place, ...step }) => step) } } : now
        expect(withoutPlaces).toEqual(before)
      }),
      { numRuns: 1000, seed: 6_02 },
    )
  })
})
