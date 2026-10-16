import { describe, expect, it } from 'vitest'
import {
  explainRouteTh,
  lintDoaVersion,
  resolveRoute,
  type CommitteeStepSpec,
  type DelegationSnapshot,
  type DoaRuleSnapshot,
  type DoaVersionSnapshot,
  type OrgSnapshot,
  type RouteInput,
} from '@/core/doa'
import { majorityOf } from '@/core/doa/resolve-route'
import { stepOutcome } from '@/core/workflow'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// S6-02 (spec §7.17 BR-WF-01 to BR-WF-05): branches of the committee engine, stepOutcome and the BR-WF-05 lint that the
// golden cases of suite workflow do not reach (§7.0 rule 4: 100% branch coverage of core/doa and core/workflow).

const ORG_S6 = 'fixtures/org-s6.yaml'
const at = new Date('2026-10-06T03:00:00Z')
const committeeVersion = () => versionSnapshots('fixtures/doa-committee.yaml').find((v) => v.code === 'DOA-WF')!
const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  documentType: 'PURCHASE_REQUEST',
  amount: { netSatang: 15_000_000n, vatSatang: 0n },
  requesterMemberId: 'req_con',
  chargedDepartmentId: 'CON',
  conflictMemberIds: ['req_con'],
  at,
  ...over,
})
/** DOA-WF with PR-02's committee step replaced */
function withCommittee(step: Partial<CommitteeStepSpec>, over: Partial<DoaVersionSnapshot> = {}): DoaVersionSnapshot {
  const v = committeeVersion()
  const rules = v.rules.map((r): DoaRuleSnapshot => (r.code === 'PR-02' ? { ...r, steps: [{ ...(r.steps[0] as CommitteeStepSpec), ...step }] } : r))
  return { ...v, rules, ...over }
}
const policy = (version: DoaVersionSnapshot, over: { org?: OrgSnapshot; delegations?: DelegationSnapshot[] } = {}) => ({
  versions: [version],
  org: over.org ?? orgSnapshot([], ORG_S6),
  delegations: over.delegations ?? [],
})
const delegation = (delegator: string, delegate: string): DelegationSnapshot => ({
  id: `D-${delegator}`,
  delegatorMemberId: delegator,
  delegateMemberId: delegate,
  startsAt: new Date('2026-10-05T00:00:00+07:00'),
  endsAt: new Date('2026-10-10T00:00:00+07:00'),
  documentTypes: null,
  maxAmountSatang: null,
  status: 'ACTIVE',
})

describe('[FR-WF-102/AC1] committee routes (BR-WF-02 to BR-WF-04)', () => {
  it('MAJORITY is floor(N ÷ 2) + 1 of the approvers named', () => {
    expect([1, 2, 3, 4, 5].map(majorityOf)).toEqual([1, 2, 2, 3, 3])
  })

  it('ALL keeps every slot; its route says the quorum without a count', () => {
    const r = resolveRoute(input(), policy(withCommittee({ quorum: 'ALL' })))
    expect(r.ok && r.data.steps[0]!.committee).toEqual({
      quorum: 'ALL',
      quorumCount: null,
      slots: [
        { slotNo: 1, assigneeMemberId: 'coo', principalMemberId: null, resolvedFrom: 'POSITION:PC1@HQ', notifyOrgAdmin: false },
        { slotNo: 2, assigneeMemberId: 'dm_fin', principalMemberId: null, resolvedFrom: 'POSITION:PC2@HQ', notifyOrgAdmin: false },
        { slotNo: 3, assigneeMemberId: 'dm_proc', principalMemberId: null, resolvedFrom: 'POSITION:PC3@HQ', notifyOrgAdmin: false },
      ],
    })
    // The step's own fields repeat slot 1, so a screen of one approver still reads it
    expect(r.ok && r.data.steps[0]).toMatchObject({ stepNo: 1, assigneeMemberId: 'coo', resolvedFrom: 'POSITION:PC1@HQ', slaBusinessMinutes: 960 })
  })

  it('ALL that loses a slot to a conflict moves the document to the next band; none above → NO_HIGHER_AUTHORITY', () => {
    const r = resolveRoute(input({ requesterMemberId: 'dm_fin', chargedDepartmentId: 'FIN', conflictMemberIds: ['dm_fin'] }), policy(withCommittee({ quorum: 'ALL' })))
    expect(r.ok ? r.data : r.error.code).toBe('NO_HIGHER_AUTHORITY')
  })

  it('ANY needs one slot left; COUNT without a count needs every approver named', () => {
    const any = resolveRoute(input({ conflictMemberIds: ['req_con', 'coo', 'dm_fin'] }), policy(withCommittee({ quorum: 'ANY' })))
    expect(any.ok && any.data.steps[0]!.committee?.slots.map((s) => s.assigneeMemberId)).toEqual(['dm_proc'])
    const none = resolveRoute(input({ conflictMemberIds: ['req_con', 'coo', 'dm_fin', 'dm_proc'] }), policy(withCommittee({ quorum: 'ANY' })))
    expect(none.ok ? none.data : none.error.code).toBe('NO_HIGHER_AUTHORITY')
    const all3 = resolveRoute(input(), policy(withCommittee({ quorum: 'COUNT' })))
    expect(all3.ok && all3.data.steps[0]!.committee).toMatchObject({ quorum: 'COUNT', quorumCount: 3 })
  })

  it('a committee seat nobody holds stops the route (APPROVER_NOT_FOUND)', () => {
    const r = resolveRoute(input(), policy(committeeVersion(), { org: orgSnapshot(['PC2@HQ'], ORG_S6) }))
    expect(r.ok ? r.data : r.error).toMatchObject({ code: 'APPROVER_NOT_FOUND', details: { ruleCode: 'PR-02', position: 'PC2' } })
  })

  it('BLOCK refuses a committee that a conflict leaves short (SOD_VIOLATION)', () => {
    const r = resolveRoute(input({ conflictMemberIds: ['req_con', 'coo', 'dm_fin'] }), policy(withCommittee({}, { selfApprovalPolicy: 'BLOCK' })))
    expect(r.ok ? r.data : r.error.code).toBe('SOD_VIOLATION')
  })

  it('each slot is delegated on its own; a delegate who already holds a slot leaves it merged', () => {
    const delegated = resolveRoute(input(), policy(committeeVersion(), { delegations: [delegation('coo', 'vp_ops')] }))
    expect(delegated.ok && delegated.data.steps[0]!.committee?.slots[0]).toMatchObject({ assigneeMemberId: 'vp_ops', principalMemberId: 'coo' })
    // dm_fin's delegate is dm_proc, who holds PC3: two slots left, still the majority of three
    const merged = resolveRoute(input(), policy(committeeVersion(), { delegations: [delegation('dm_fin', 'dm_proc')] }))
    expect(merged.ok && merged.data.steps[0]!.committee?.slots.map((s) => s.assigneeMemberId)).toEqual(['coo', 'dm_proc'])
  })

  it('a committee that delegation merges below its quorum could never pass (APPROVER_NOT_FOUND)', () => {
    const r = resolveRoute(input(), policy(withCommittee({ quorum: 'ALL' }), { delegations: [delegation('dm_fin', 'dm_proc'), delegation('coo', 'dm_proc')] }))
    expect(r.ok).toBe(true)
    const count = resolveRoute(input(), policy(withCommittee({ quorum: 'COUNT', quorumCount: 3 }), { delegations: [delegation('dm_fin', 'dm_proc')] }))
    expect(count.ok ? count.data : count.error).toMatchObject({ code: 'APPROVER_NOT_FOUND', details: { position: 'COMMITTEE' } })
  })

  it('a delegate who conflicts leaves the slot with its holder and ORG_ADMIN is told (BR-DLG-05)', () => {
    const r = resolveRoute(input(), policy(committeeVersion(), { delegations: [delegation('coo', 'req_con')] }))
    expect(r.ok && r.data.steps[0]).toMatchObject({ notifyOrgAdmin: true, committee: { slots: [{ assigneeMemberId: 'coo', notifyOrgAdmin: true }, {}, {}] } })
  })

  it('repeated approvers never collapse into a committee (BR-WF-10)', () => {
    const v = committeeVersion()
    const twoSteps = v.rules.map((r): DoaRuleSnapshot =>
      r.code === 'PR-02' ? { ...r, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }, r.steps[0]!] } : r,
    )
    const r = resolveRoute(input(), policy({ ...v, rules: twoSteps }))
    expect(r.ok && r.data.steps.map((s) => [s.stepNo, s.assigneeMemberId, s.committee ? 'committee' : 'one'])).toEqual([
      [1, 'coo', 'one'],
      [2, 'coo', 'committee'],
    ])
  })

  it('the Thai explanation names every member and the votes needed', () => {
    const r = resolveRoute(input(), policy(committeeVersion()))
    expect(r.ok && r.data.explanationTh).toBe(
      'DOA-WF ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 150,000.00 บาท (รวม VAT) อยู่ในช่วงมากกว่า 100,000.00 → คณะกรรมการ (PC1, PC2, PC3) ต้องได้ 2 เสียง',
    )
    const all = resolveRoute(input(), policy(withCommittee({ quorum: 'ALL' })))
    expect(all.ok && all.data.explanationTh).toMatch(/คณะกรรมการ \(PC1, PC2, PC3\) ต้องได้ทุกเสียง$/)
    const org = orgSnapshot([], ORG_S6)
    const text = explainRouteTh({
      version: committeeVersion(),
      documentType: 'PURCHASE_REQUEST',
      basisAmount: null,
      amountBasis: 'GROSS',
      rule: committeeVersion().rules.find((x) => x.code === 'PR-02')!,
      escalations: [],
      steps: [{ resolvedFrom: 'POSITION:PC1@HQ', assigneeMemberId: 'coo', principalMemberId: null, committee: { quorum: 'COUNT', quorumCount: null, slots: [{ resolvedFrom: 'POSITION:PC1@HQ', assigneeMemberId: 'coo', principalMemberId: null }] } }],
      org,
    })
    expect(text).toMatch(/คณะกรรมการ \(PC1\) ต้องได้ 1 เสียง$/)
  })
})

describe('[FR-WF-102/AC1] lint of committee steps (BR-WF-05)', () => {
  const lint = (step: Partial<CommitteeStepSpec>) => lintDoaVersion(withCommittee(step), orgSnapshot([], ORG_S6), committeeVersion().effectiveFrom).errors.map((e) => e.code)
  it.each([
    [{ quorum: 'COUNT' as const, quorumCount: 2 }, []],
    [{ quorum: 'COUNT' as const, quorumCount: undefined }, ['DOA_LINT_QUORUM_INVALID']],
    [{ quorum: 'COUNT' as const, quorumCount: 0 }, ['DOA_LINT_QUORUM_INVALID']],
    [{ quorum: 'COUNT' as const, quorumCount: 1.5 }, ['DOA_LINT_QUORUM_INVALID']],
    [{ quorum: 'ALL' as const, quorumCount: 2 }, ['DOA_LINT_QUORUM_INVALID']],
    [{ quorum: 'MAJORITY' as const }, []],
  ])('%o → %o', (step, codes) => {
    const { quorumCount, ...rest } = step as Partial<CommitteeStepSpec>
    const base = committeeVersion().rules.find((r) => r.code === 'PR-02')!.steps[0] as CommitteeStepSpec
    const { quorumCount: _drop, ...plain } = base
    expect(lint({ ...plain, ...rest, ...(quorumCount !== undefined ? { quorumCount } : {}) })).toEqual(codes)
  })

  it('a committee seat that is vacant, or a named member, is a warning', () => {
    const v = withCommittee({ approvers: [{ kind: 'POSITION_OF_ORG', position: 'PC1' }, { kind: 'MEMBER', memberId: 'cfo' }] })
    const vacant = lintDoaVersion(v, orgSnapshot(['PC1@HQ'], ORG_S6), v.effectiveFrom)
    expect(vacant.warnings.map((w) => [w.code, w.rule])).toEqual([
      ['DOA_LINT_VACANT_POSITION', 'PR-02'],
      ['DOA_LINT_MEMBER_APPROVER', 'PR-02'],
    ])
  })

  it('a governance rule run by a committee must resolve every seat from every department', () => {
    const v = committeeVersion()
    const step: CommitteeStepSpec = { approvers: [{ kind: 'POSITION_OF_ORG', position: 'CEO' }, { kind: 'POSITION_OF_ORG', position: 'PC1' }], slaBusinessMinutes: 960, mode: 'PARALLEL', quorum: 'ALL' }
    const rules = v.rules.map((r): DoaRuleSnapshot => (r.code === 'DOA-CHG-01' ? { ...r, steps: [step] } : r))
    expect(lintDoaVersion({ ...v, rules }, orgSnapshot([], ORG_S6), v.effectiveFrom).errors).toEqual([])
    expect(lintDoaVersion({ ...v, rules }, orgSnapshot(['PC1@HQ'], ORG_S6), v.effectiveFrom).errors.map((e) => [e.code, e.rule])).toEqual([['DOA_LINT_UNRESOLVABLE_GOVERNANCE', 'DOA-CHG-01']])
  })
})

describe('[FR-WF-102/AC1] stepOutcome branches (BR-WF-01)', () => {
  it('ANY waits until a slot decides; COUNT without a count needs every slot', () => {
    expect(stepOutcome({ quorum: 'ANY', slots: [null, null] })).toEqual({ ok: true, data: { outcome: 'OPEN', cancel: [] } })
    expect(stepOutcome({ quorum: 'ANY', slots: ['APPROVE', null] })).toEqual({ ok: true, data: { outcome: 'APPROVED', cancel: [2] } })
    expect(stepOutcome({ quorum: 'COUNT', slots: ['APPROVE', null] })).toEqual({ ok: true, data: { outcome: 'OPEN', cancel: [] } })
    expect(stepOutcome({ slots: ['APPROVE', 'APPROVE'] })).toEqual({ ok: true, data: { outcome: 'APPROVED', cancel: [] } })
  })

  it('a reviewer never rejects: the decision is refused and nothing moves (BR-WF-09)', () => {
    expect(stepOutcome({ kind: 'REVIEW', groups: [{ quorum: 'ALL', slots: [1] }], slots: ['REJECT'] })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'REVIEW_CANNOT_REJECT' } } })
  })

  it('a REVIEW step returns as soon as a group does, and closes every open slot', () => {
    expect(stepOutcome({ kind: 'REVIEW', groups: [{ quorum: 'ALL', slots: [1] }, { quorum: 'ALL', slots: [2] }], slots: [null, 'RETURN'] })).toEqual({ ok: true, data: { outcome: 'RETURNED', cancel: [1] } })
    expect(stepOutcome({ kind: 'REVIEW', slots: ['APPROVE'] })).toEqual({ ok: true, data: { outcome: 'APPROVED', cancel: [] } })
  })

  it('a REVIEW group that passes closes its open slots, except those another waiting group still counts', () => {
    const groups = [
      { quorum: 'ANY' as const, slots: [1, 2] },
      { quorum: 'COUNT' as const, quorumCount: 1, slots: [2, 3] },
    ]
    expect(stepOutcome({ kind: 'REVIEW', groups, slots: ['APPROVE', null, null] })).toEqual({ ok: true, data: { outcome: 'OPEN', cancel: [] } })
    expect(stepOutcome({ kind: 'REVIEW', groups, slots: [null, null, 'APPROVE'] })).toEqual({ ok: true, data: { outcome: 'OPEN', cancel: [] } })
    expect(stepOutcome({ kind: 'REVIEW', groups: [groups[0]!, { quorum: 'ALL', slots: [3] }], slots: ['APPROVE', null, null] })).toEqual({ ok: true, data: { outcome: 'OPEN', cancel: [2] } })
  })
})
