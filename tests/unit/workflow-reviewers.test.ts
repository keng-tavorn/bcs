import { describe, expect, it } from 'vitest'
import type { DelegationSnapshot, OrgSnapshot } from '@/core/doa'
import {
  lintWorkflowVersion,
  resolveRequestRoute,
  resolveReviewer,
  resolveReviewStep,
  workflowConditionHolds,
  workflowVersionAt,
  type ReviewInput,
  type WorkflowRuleSnapshot,
  type WorkflowVersionSnapshot,
} from '@/core/workflow'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'
import { workflowFixture } from '../golden/workflow-fixtures'

// S6-03 (spec §7.17 BR-WF-06 to BR-WF-11, FR-WF-101 FR-WF-103): branches of the reviewer engine and the workflow lint
// that the golden cases of suite workflow do not reach (§7.0 rule 4: 100% branch coverage of core/workflow).

const ORG = 'fixtures/org-s6.yaml'
const at = new Date('2026-10-06T03:00:00Z')
const org = (vacate: string[] = []): OrgSnapshot => orgSnapshot(vacate, ORG)
const fx = workflowFixture(['fixtures/workflow-versions.yaml'])
const POS = (position: string, department: string) => ({ kind: 'POSITION_AT' as const, position, department })
const rule = (code: string, over: Partial<WorkflowRuleSnapshot> = {}): WorkflowRuleSnapshot => ({
  code,
  requestTypeCodes: ['BUY_GOODS'],
  when: {},
  reviewers: [POS('DM', 'QSE')],
  fallback: POS('VP', 'OPS'),
  mode: 'ALL',
  quorumCount: null,
  slaBusinessMinutes: 480,
  sortOrder: 0,
  ...over,
})
const version = (rules: WorkflowRuleSnapshot[], over: Partial<WorkflowVersionSnapshot> = {}): WorkflowVersionSnapshot => ({
  id: 'WF@1',
  code: 'WF',
  versionNo: 1,
  status: 'PUBLISHED',
  effectiveFrom: new Date('2026-10-01T00:00:00+07:00'),
  effectiveTo: null,
  rules,
  ...over,
})
const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
  requestType: 'BUY_GOODS',
  amountGross: 500_000n,
  amountNet: 467_290n,
  lineCategories: [],
  budgetAccountCodes: [],
  fields: {},
  requesterMemberId: 'req_con',
  conflictMemberIds: ['req_con'],
  at,
  basisAmountSatang: 500_000n,
  ...over,
})
const review = (rules: WorkflowRuleSnapshot[], over: Partial<ReviewInput> = {}, delegations: DelegationSnapshot[] = [], vacate: string[] = []) =>
  resolveReviewStep([version(rules)], input(over), org(vacate), delegations)
const slotsOf = (r: ReturnType<typeof review>) => (r.ok && r.data ? r.data.slots.map((s) => [s.slotNo, s.ruleCodes, s.assignees.map((a) => a.assigneeMemberId)]) : r)
const groupsOf = (r: ReturnType<typeof review>) => (r.ok && r.data ? r.data.groups.map((g) => [g.ruleCodes, g.quorum, g.slotNos]) : r)

describe('[FR-WF-101/AC1] the workflow version in effect and the conditions of its rules (BR-WF-07, BR-WF-12)', () => {
  it('takes the published or superseded version in effect at the time, the latest start first', () => {
    const v1 = version([], { id: 'v1', versionNo: 1, status: 'SUPERSEDED', effectiveTo: new Date('2026-10-05T00:00:00Z') })
    const v2 = version([], { id: 'v2', versionNo: 2, effectiveFrom: new Date('2026-10-05T00:00:00Z') })
    const draft = version([], { id: 'v3', versionNo: 3, status: 'DRAFT', effectiveFrom: new Date('2026-10-05T00:00:00Z') })
    expect(workflowVersionAt([v1, v2, draft], at)?.id).toBe('v2')
    expect(workflowVersionAt([v1, v2], new Date('2026-10-04T00:00:00Z'))?.id).toBe('v1')
    expect(workflowVersionAt([v2], new Date('2026-09-01T00:00:00Z'))).toBeNull()
    expect(workflowVersionAt([v2, version([], { id: 'v2b', versionNo: 4, effectiveFrom: v2.effectiveFrom })], at)?.id).toBe('v2b')
  })

  it('anyIn reads the set variables and a form field of several answers; the ops of §7.9 keep their meaning', () => {
    const i = input({ lineCategories: ['FUEL'], budgetAccountCodes: ['121201'], fields: { sites: ['A', 'B'], site: 'C' } })
    expect(workflowConditionHolds({ field: '$lineCategories', op: 'anyIn', value: ['SAFETY', 'FUEL'] }, i)).toBe(true)
    expect(workflowConditionHolds({ field: '$budgetAccountCodes', op: 'anyIn', value: ['121101'] }, i)).toBe(false)
    expect(workflowConditionHolds({ field: 'sites', op: 'anyIn', value: ['B'] }, i)).toBe(true)
    expect(workflowConditionHolds({ field: 'site', op: 'anyIn', value: ['C'] }, i)).toBe(true)
    expect(workflowConditionHolds({ field: 'nothing', op: 'anyIn', value: ['C'] }, i)).toBe(false)
    expect(workflowConditionHolds({ field: 'site', op: 'anyIn', value: 'C' }, i)).toBe(false)
    expect(workflowConditionHolds({ any: [{ field: '$requestType', op: 'eq', value: 'IT_PURCHASE' }, { field: '$amountGross', op: 'gt', value: '4999.99' }] }, i)).toBe(true)
    expect(workflowConditionHolds({ all: [{ field: '$amountNet', op: 'gte', value: '4672.90' }, { field: 'site', op: 'eq', value: 'C' }] }, i)).toBe(true)
    expect(workflowConditionHolds({}, i)).toBe(true)
  })
})

describe('[FR-WF-101/AC4] reviewers and their fallbacks (BR-WF-08)', () => {
  it('a named member reviews while active; an unknown department finds no one', () => {
    expect(resolveReviewer({ kind: 'MEMBER', memberId: 'dm_leg' }, org(), at)).toEqual({ memberId: 'dm_leg', resolvedFrom: 'MEMBER:dm_leg', viaPosition: false })
    const inactive = { ...org(), members: org().members.map((m) => (m.id === 'dm_leg' ? { ...m, active: false } : m)) }
    expect(resolveReviewer({ kind: 'MEMBER', memberId: 'dm_leg' }, inactive, at)).toBeNull()
    expect(resolveReviewer(POS('DM', 'NOPE'), org(), at)).toBeNull()
  })

  it('no fallback, or a fallback that conflicts, leaves the rule without a reviewer (REVIEWER_NOT_FOUND)', () => {
    expect(review([rule('RV-1', { fallback: null })], {}, [], ['DM@QSE'])).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND', details: { rule: 'RV-1', position: 'DM', department: 'QSE' } } })
    expect(review([rule('RV-1', { fallback: POS('VP', 'OPS') })], { conflictMemberIds: ['req_con', 'dm_qse', 'vp_ops'] })).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND' } })
    expect(review([rule('RV-1', { mode: 'ANY', fallback: null, reviewers: [{ kind: 'MEMBER', memberId: 'ghost' }] })])).toMatchObject({ ok: false, error: { details: { position: 'MEMBER:ghost', department: '' } } })
  })

  it('no matching rule, or no version in effect, gives no REVIEW step', () => {
    expect(review([rule('RV-1', { requestTypeCodes: ['IT_PURCHASE'] })])).toEqual({ ok: true, data: null })
    expect(resolveReviewStep([], input(), org(), [])).toEqual({ ok: true, data: null })
  })

  it('each slot is delegated on its own (BR-DLG-01 to 05)', () => {
    const d: DelegationSnapshot = { id: 'D', delegatorMemberId: 'dm_qse', delegateMemberId: 'asst_con', startsAt: new Date('2026-10-05T00:00:00Z'), endsAt: new Date('2026-10-09T00:00:00Z'), documentTypes: null, maxAmountSatang: null, status: 'ACTIVE' }
    const r = review([rule('RV-1')], {}, [d])
    expect(r.ok && r.data?.slots[0]!.assignees).toEqual([{ assigneeMemberId: 'asst_con', principalMemberId: 'dm_qse', resolvedFrom: 'POSITION:DM@QSE', notifyOrgAdmin: false }])
  })

  it('slots are merged after delegation: two reviewers who delegated to one person give that person one slot (BR-WF-02)', () => {
    const to = (delegatorMemberId: string): DelegationSnapshot => ({ id: `D-${delegatorMemberId}`, delegatorMemberId, delegateMemberId: 'asst_con', startsAt: new Date('2026-10-05T00:00:00Z'), endsAt: new Date('2026-10-09T00:00:00Z'), documentTypes: null, maxAmountSatang: null, status: 'ACTIVE' })
    const both = [to('dm_qse'), to('dm_fin')]
    // two ALL rules: one slot, held for the first, answering both groups
    const all = review([rule('RV-1'), rule('RV-2', { sortOrder: 1, reviewers: [POS('DM', 'FIN')] })], {}, both)
    expect(slotsOf(all)).toEqual([[1, ['RV-1', 'RV-2'], ['asst_con']]])
    expect(all.ok && all.data?.slots[0]!.assignees[0]!.principalMemberId).toBe('dm_qse')
    expect(groupsOf(all)).toEqual([
      [['RV-1'], 'ALL', [1]],
      [['RV-2'], 'ALL', [1]],
    ])
    // COUNT 2 of 3: the delegate holds one slot, so two people still decide
    const count = review([rule('RV-3', { mode: 'COUNT', quorumCount: 2, fallback: null, reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN'), POS('DM', 'IT')] })], {}, both)
    expect(slotsOf(count)).toEqual([
      [1, ['RV-3'], ['asst_con']],
      [2, ['RV-3'], ['dm_it']],
    ])
    // COUNT 3 of 3 cannot be met by two people
    expect(review([rule('RV-4', { mode: 'COUNT', quorumCount: 3, fallback: null, reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN'), POS('DM', 'IT')] })], {}, both)).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND' } })
    // ANY: the delegate appears once among the reviewers of the slot
    const any = review([rule('RV-5', { mode: 'ANY' }), rule('RV-6', { mode: 'ANY', sortOrder: 1, reviewers: [POS('DM', 'FIN')] })], {}, both)
    expect(slotsOf(any)).toEqual([[1, ['RV-5', 'RV-6'], ['asst_con']]])
  })
})

describe('[FR-WF-101/AC3] [INV-WF-02] slots and groups: one person holds one slot of the step (BR-WF-02, BR-WF-06)', () => {
  it('two ALL rules of one person merge into one slot that answers both, with the shorter SLA', () => {
    const r = review([rule('RV-1', { slaBusinessMinutes: 960 }), rule('RV-2', { sortOrder: 1, slaBusinessMinutes: 480 })])
    expect(slotsOf(r)).toEqual([[1, ['RV-1', 'RV-2'], ['dm_qse']]])
    expect(groupsOf(r)).toEqual([
      [['RV-1'], 'ALL', [1]],
      [['RV-2'], 'ALL', [1]],
    ])
    expect(r.ok && r.data?.slots[0]!.slaBusinessMinutes).toBe(480)
    expect(r.ok && r.data?.slaBusinessMinutes).toBe(480)
  })

  it('two ANY rules of one reviewer give one reviewer in the ANY slot', () => {
    expect(slotsOf(review([rule('RV-1', { mode: 'ANY' }), rule('RV-2', { mode: 'ANY', sortOrder: 1 })]))).toEqual([[1, ['RV-1', 'RV-2'], ['dm_qse']]])
  })

  it('an ANY slot whose every reviewer holds a slot of their own is left out', () => {
    const r = review([rule('RV-1'), rule('RV-2', { sortOrder: 1, reviewers: [POS('DM', 'PROC')] }), rule('RV-6', { mode: 'ANY', sortOrder: 2 }), rule('RV-8', { mode: 'ANY', sortOrder: 3, reviewers: [POS('DM', 'PROC')] })])
    expect(slotsOf(r)).toEqual([
      [1, ['RV-1'], ['dm_qse']],
      [2, ['RV-2'], ['dm_proc']],
    ])
    expect(groupsOf(r)).toEqual([
      [['RV-1'], 'ALL', [1]],
      [['RV-2'], 'ALL', [2]],
      [['RV-6', 'RV-8'], 'ANY', [1, 2]],
    ])
  })

  it('a reviewer of the ANY slot who holds an ALL slot leaves it; the ALL slot counts for the ANY group too', () => {
    const r = review([rule('RV-1'), rule('RV-6', { mode: 'ANY', sortOrder: 1 }), rule('RV-8', { mode: 'ANY', sortOrder: 2, reviewers: [POS('DM', 'PROC')] })])
    expect(slotsOf(r)).toEqual([
      [1, ['RV-1'], ['dm_qse']],
      [2, ['RV-6', 'RV-8'], ['dm_proc']],
    ])
    expect(groupsOf(r)).toEqual([
      [['RV-1'], 'ALL', [1]],
      [['RV-6', 'RV-8'], 'ANY', [1, 2]],
    ])
  })

  it('an ANY slot of one reviewer who holds an ALL slot merges into it: the slot answers both rules', () => {
    const r = review([rule('RV-1'), rule('RV-6', { mode: 'ANY', sortOrder: 1 })])
    expect(slotsOf(r)).toEqual([[1, ['RV-1', 'RV-6'], ['dm_qse']]])
    expect(groupsOf(r)).toEqual([
      [['RV-1'], 'ALL', [1]],
      [['RV-6'], 'ANY', [1]],
    ])
  })

  it('a COUNT reviewer who is in the ANY slot takes a slot of their own, which counts for both groups', () => {
    const r = review([
      rule('RV-6', { mode: 'ANY' }),
      rule('RV-8', { mode: 'ANY', sortOrder: 1, reviewers: [POS('DM', 'PROC')] }),
      rule('RV-9', { mode: 'COUNT', quorumCount: 2, sortOrder: 2, reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN'), POS('DM', 'IT')] }),
    ])
    expect(slotsOf(r)).toEqual([
      [1, ['RV-6', 'RV-8'], ['dm_proc']],
      [2, ['RV-9'], ['dm_qse']],
      [3, ['RV-9'], ['dm_fin']],
      [4, ['RV-9'], ['dm_it']],
    ])
    expect(groupsOf(r)).toEqual([
      [['RV-6', 'RV-8'], 'ANY', [1, 2]],
      [['RV-9'], 'COUNT', [2, 3, 4]],
    ])
  })

  it('a COUNT rule that names one person twice, and a COUNT rule without a count, count each person once', () => {
    const twice = review([rule('RV-9', { mode: 'COUNT', quorumCount: 2, reviewers: [POS('DM', 'QSE'), POS('DM', 'QSE'), POS('DM', 'FIN')] })])
    expect(slotsOf(twice)).toEqual([
      [1, ['RV-9'], ['dm_qse']],
      [2, ['RV-9'], ['dm_fin']],
    ])
    const all = review([rule('RV-9', { mode: 'COUNT', quorumCount: null, reviewers: [POS('DM', 'QSE'), POS('DM', 'QSE')] })])
    expect(all).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND' } })
  })
})

describe('[FR-WF-101/AC1] the route of a request: refusals of either engine come back as they are', () => {
  const doa = versionSnapshots()
  const route = (over: { conflictMemberIds?: string[]; amount?: bigint } = {}) => ({
    documentType: 'PURCHASE_REQUEST' as const,
    amount: { netSatang: over.amount ?? 500_000n, vatSatang: 0n },
    requesterMemberId: 'req_con',
    chargedDepartmentId: 'CON',
    conflictMemberIds: over.conflictMemberIds ?? ['req_con'],
    at,
  })
  const extra = { requestType: 'BUY_GOODS', amountGross: 500_000n, amountNet: 500_000n, lineCategories: [], budgetAccountCodes: [], fields: {} }
  it('the DOA refuses first; a reviewer refusal comes after a DOA route was found', () => {
    expect(resolveRequestRoute(route({ amount: 0n }), extra, { versions: doa, org: org(), delegations: [], workflows: [] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(resolveRequestRoute(route(), extra, { versions: doa, org: org(['DM@QSE']), delegations: [], workflows: [version([rule('RV-1', { fallback: null })])] })).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND' } })
    expect(resolveRequestRoute(route(), extra, { versions: doa, org: org(), delegations: [], workflows: [] })).toMatchObject({ ok: true, data: { review: null, approval: { ruleCode: 'PR-01' } } })
  })
})

describe('[FR-WF-103/AC2] lint of a workflow version (BR-WF-11)', () => {
  const base = fx.versions[0]!
  const lint = (rules: WorkflowRuleSnapshot[], vacate: string[] = []) => lintWorkflowVersion({ ...base, rules }, org(vacate), fx.requestTypes, base.effectiveFrom)
  it('the fixture version passes as it is', () => {
    expect(lint([...base.rules])).toEqual({ errors: [], warnings: [] })
  })

  it('a field of a rule of no known type, or missing from one of its types, is unknown; nested conditions are read', () => {
    const r = lint([rule('RV-X', { requestTypeCodes: ['NOPE'], when: { any: [{ field: 'scopeOfWork', op: 'notEmpty' }] } }), rule('RV-Y', { requestTypeCodes: ['HIRE_SERVICE', 'BUY_GOODS'], when: { all: [{ field: 'scopeOfWork', op: 'notEmpty' }, { field: '$lineCategories', op: 'anyIn', value: ['IT'] }] } })])
    expect(r.errors).toEqual([
      { code: 'WF_LINT_UNKNOWN_REQUEST_TYPE', rule: 'RV-X', requestType: 'NOPE' },
      { code: 'WF_LINT_UNKNOWN_FIELD', rule: 'RV-X', field: 'scopeOfWork' },
      { code: 'WF_LINT_UNKNOWN_FIELD', rule: 'RV-Y', field: 'scopeOfWork' },
    ])
  })

  it('quorums out of shape, a code used twice and a named member are reported', () => {
    const r = lint([
      rule('RV-1', { reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN')] }),
      rule('RV-2', { mode: 'COUNT', quorumCount: 3, reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN')] }),
      rule('RV-3', { mode: 'COUNT', quorumCount: null, reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN')] }),
      rule('RV-4', { quorumCount: 1 }),
      rule('RV-1', { reviewers: [{ kind: 'MEMBER', memberId: 'dm_leg' }] }),
    ])
    expect(r.errors).toEqual([
      { code: 'WF_LINT_QUORUM_INVALID', rule: 'RV-1' },
      { code: 'WF_LINT_QUORUM_INVALID', rule: 'RV-2' },
      { code: 'WF_LINT_QUORUM_INVALID', rule: 'RV-3' },
      { code: 'WF_LINT_QUORUM_INVALID', rule: 'RV-4' },
      { code: 'WF_LINT_DUPLICATE_CODE', rule: 'RV-1' },
    ])
    expect(r.warnings).toEqual([{ code: 'WF_LINT_MEMBER_REVIEWER', rule: 'RV-1' }])
  })
})
