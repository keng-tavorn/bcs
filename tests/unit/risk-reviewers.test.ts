import { describe, expect, it } from 'vitest'
import type { DelegationSnapshot, OrgSnapshot } from '@/core/doa/types'
import { delegationCoversReview, riskReviewers, riskReviewOutcome } from '@/core/risk'
import { checkSod } from '@/core/sod'
import { lintWorkflowVersion, requestScopeOnly, type WorkflowRuleSnapshot, type WorkflowVersionSnapshot } from '@/core/workflow'
import { workflowRuleFromRow } from '@/server/workflow/snapshot'

// S11-06 (BR-RSK-07 · ADR-222): the edges of the reviewer adapter the golden file does not reach — the outcome of a round,
// the delegations that count for a reviewer's task, a RISK rule without domains — and the lint of RISK_ASSESSMENT rules
// (WF_LINT_RISK_DOMAIN_REQUIRED WF_LINT_RISK_FIELD WF_LINT_RISK_QUORUM) beside the REQUEST rules of the same version.

const EPOCH = new Date('2000-01-01T00:00:00Z')
const AT = new Date('2026-11-02T03:00:00Z')
const org: OrgSnapshot = {
  departments: [
    { id: 'HQ', code: 'HQ', nameTh: 'HQ', parentId: null },
    { id: 'IT', code: 'IT', nameTh: 'IT', parentId: 'HQ' },
  ],
  holders: [{ positionCode: 'DM', departmentId: 'IT', memberId: 'dm_it', validFrom: EPOCH, validTo: null }],
  members: [
    { id: 'dm_it', displayNameTh: 'dm_it', active: true },
    { id: 'proc', displayNameTh: 'proc', active: true },
  ],
}
const rule = (over: Partial<WorkflowRuleSnapshot> = {}): WorkflowRuleSnapshot => ({
  code: 'RR-01',
  requestTypeCodes: [],
  when: { field: 'accessesSystems', op: 'eq', value: 'Y' },
  reviewers: [{ kind: 'POSITION_AT', position: 'DM', department: 'IT' }],
  fallback: null,
  mode: 'ALL',
  quorumCount: null,
  slaBusinessMinutes: 960,
  sortOrder: 1,
  scope: 'RISK_ASSESSMENT',
  riskDomains: ['INFOSEC'],
  ...over,
})
const version = (rules: WorkflowRuleSnapshot[]): WorkflowVersionSnapshot => ({ id: 'WF@1', code: 'WF', versionNo: 1, status: 'PUBLISHED', effectiveFrom: EPOCH, effectiveTo: null, rules })
const input = { screening: { processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' } as const, tier: 'MEDIUM' as const, inherentTier: 'MEDIUM' as const, categoryCodes: [], payeeType: 'JURISTIC', openedById: 'proc', filledOnBehalfByIds: [], at: AT }
const delegation = (over: Partial<DelegationSnapshot>): DelegationSnapshot => ({ id: 'D1', delegatorMemberId: 'dm_it', delegateMemberId: 'proc', startsAt: EPOCH, endsAt: new Date('2100-01-01'), documentTypes: null, maxAmountSatang: null, status: 'ACTIVE', ...over })

describe('[FR-RSK-202] [BR-RSK-07] the outcome of a round of risk reviewers', () => {
  it('every slot passed → COMPLETED; one returned → RETURNED; some open → OPEN', () => {
    const slots = (a: 'PASS' | 'RETURN' | null, b: 'PASS' | 'RETURN' | null) => [
      { slotNo: 2, ruleCodes: ['RR-02'], decision: b },
      { slotNo: 1, ruleCodes: ['RR-01'], decision: a },
    ]
    expect(riskReviewOutcome(slots('PASS', 'PASS'))).toBe('COMPLETED')
    expect(riskReviewOutcome(slots('PASS', 'RETURN'))).toBe('RETURNED')
    expect(riskReviewOutcome(slots('PASS', null))).toBe('OPEN')
  })

  it('a slot that answers two rules counts for both', () => {
    expect(riskReviewOutcome([{ slotNo: 1, ruleCodes: ['RR-01', 'RR-04'], decision: 'PASS' }])).toBe('COMPLETED')
  })
})

describe('[BR-RSK-07] [BR-DLG-01] the delegations that count for a reviewer task', () => {
  it('only those that limit neither the document types nor the amount', () => {
    expect(delegationCoversReview(delegation({}))).toBe(true)
    expect(delegationCoversReview(delegation({ documentTypes: [] }))).toBe(true)
    expect(delegationCoversReview(delegation({ documentTypes: ['PURCHASE_ORDER'] }))).toBe(false)
    expect(delegationCoversReview(delegation({ maxAmountSatang: 100_000n }))).toBe(false)
  })
})

describe('[BR-RSK-07] riskReviewers reads only the RISK rules', () => {
  it('a version of REQUEST rules only has no reviewer; a RISK rule without domains gives a slot with none', () => {
    const request = rule({ scope: undefined, riskDomains: undefined, requestTypeCodes: ['IT_PURCHASE'], when: {} })
    expect(riskReviewers([version([request])], input, org, [])).toEqual({ ok: true, data: null })
    const r = riskReviewers([version([rule({ riskDomains: undefined })])], input, org, [])
    expect(r.ok && r.data?.slots[0]).toMatchObject({ ruleCodes: ['RR-01'], riskDomains: [] })
  })
})

describe('[BR-RSK-07] lint of RISK_ASSESSMENT rules (WF_LINT_RISK_*)', () => {
  const lint = (rules: WorkflowRuleSnapshot[]) => lintWorkflowVersion(version(rules), org, { IT_PURCHASE: ['category'] }, AT)

  it('a rule of known domains, screening fields and one reviewer of ALL passes; the request-type checks never see it', () => {
    expect(lint([rule({ when: { all: [{ field: 'accessesSystems', op: 'eq', value: 'Y' }, { field: '$tier', op: 'eq', value: 'HIGH' }] } })]).errors).toEqual([])
  })

  it('names what is wrong, domains then fields then quorum, and a code used twice across scopes', () => {
    const r = lint([
      rule({ code: 'RR-01', riskDomains: [] }),
      rule({ code: 'RR-02', riskDomains: ['LEGAL'] }),
      rule({ code: 'RR-03', when: { field: 'category', op: 'eq', value: 'IT' } }),
      rule({ code: 'RR-04', mode: 'ANY' }),
      rule({ code: 'RR-05', reviewers: [rule().reviewers[0]!, rule().reviewers[0]!] }),
      rule({ code: 'RR-06', quorumCount: 1 }),
      rule({ code: 'RR-07', riskDomains: undefined }),
      rule({ code: 'RV-01', scope: undefined, riskDomains: undefined, requestTypeCodes: ['IT_PURCHASE'], when: { field: 'category', op: 'eq', value: 'X' } }),
      rule({ code: 'RV-01' }),
    ])
    expect(r.errors).toEqual([
      { code: 'WF_LINT_RISK_DOMAIN_REQUIRED', rule: 'RR-01' },
      { code: 'WF_LINT_RISK_DOMAIN_REQUIRED', rule: 'RR-02' },
      { code: 'WF_LINT_RISK_FIELD', rule: 'RR-03', field: 'category' },
      { code: 'WF_LINT_RISK_QUORUM', rule: 'RR-04' },
      { code: 'WF_LINT_RISK_QUORUM', rule: 'RR-05' },
      { code: 'WF_LINT_RISK_QUORUM', rule: 'RR-06' },
      { code: 'WF_LINT_RISK_DOMAIN_REQUIRED', rule: 'RR-07' },
      { code: 'WF_LINT_DUPLICATE_CODE', rule: 'RV-01' },
    ])
    expect(r.warnings.filter((w) => w.code === 'WF_LINT_NO_FALLBACK')).toHaveLength(9)
  })
})

describe('[FR-RSK-202/AC2] a RISK_ASSESSMENT rule never routes a request, whatever its row holds', () => {
  it('requestScopeOnly drops the RISK rules and keeps a version of REQUEST rules as it is', () => {
    const request = rule({ code: 'RV-01', scope: undefined, riskDomains: undefined, requestTypeCodes: ['IT_PURCHASE'], when: {} })
    // a damaged RISK row that names a request type is still never a reviewer of a request
    const risk = rule({ code: 'RR-01', requestTypeCodes: ['IT_PURCHASE'], when: {} })
    const mixed = version([request, risk])
    expect(requestScopeOnly([mixed])[0]!.rules.map((r) => r.code)).toEqual(['RV-01'])
    const plain = version([request])
    expect(requestScopeOnly([plain])[0]).toBe(plain)
  })

  it('the stored scope and domains reach the engine for a RISK rule only (REQUEST rows keep their old shape · GC-WF unchanged)', () => {
    const base = { code: 'R', requestTypeCodes: [], when: {}, reviewers: [{ kind: 'POSITION_AT', position: 'DM', department: 'IT' }], fallback: null, mode: 'ALL', quorumCount: null, slaBusinessMinutes: 60, sortOrder: 1 }
    expect(workflowRuleFromRow({ ...base, scope: 'RISK_ASSESSMENT', riskDomains: ['INFOSEC'] })).toMatchObject({ scope: 'RISK_ASSESSMENT', riskDomains: ['INFOSEC'] })
    const request = workflowRuleFromRow({ ...base, requestTypeCodes: ['IT_PURCHASE'], scope: 'REQUEST', riskDomains: [] })
    expect('scope' in request || 'riskDomains' in request).toBe(false)
  })
})

describe('[FR-RSK-202/AC5] [BR-SOD-16] who prepared an assessment never reviews it', () => {
  const policy = { approverMayReceive: false, requesterMayReceive: true }
  it('the opener and whoever filled it in are refused; another member is not', () => {
    const action = (actor: string) => checkSod({ kind: 'DECIDE_RISK_REVIEW', actorMemberId: actor, assessmentPreparerMemberIds: ['proc', 'filler'] }, policy)
    expect(action('proc')).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-16' })
    expect(action('filler')).toEqual({ ok: false, error: 'SOD_VIOLATION', rule: 'BR-SOD-16' })
    expect(action('dm_it')).toEqual({ ok: true })
  })
})
