import { describe, expect, it } from 'vitest'
import { resolveRoute, type DelegationSnapshot, type DoaRuleSnapshot, type DoaVersionSnapshot, type RouteInput } from '@/core/doa'
import { activateStep, stepOfRoute } from '@/core/workflow'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// The DOA step number a stored step keeps (ApprovalStep.doaStepNo, BR-WF-06) is its place in the rule before repeated
// approvers merged (RouteStep.ruleStepNo), and a waiting step that starts finds its approver in the route's own rule
// (BR-WF-14) without merging again: the holders of the submit and of the start may merge differently (ADR-073
// pre-review). Before, the step was matched by its place on the route after merging, so a later step could go to the
// approver of another step of the rule — the CFO's step to the VP — or find nobody.

const B = (baht: number) => BigInt(Math.round(baht * 100))
const v1 = () => versionSnapshots().find((v) => v.versionNo === 1)!
const submitAt = new Date('2026-10-06T03:00:00Z')
const laterAt = new Date('2026-10-12T03:00:00Z')
const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  documentType: 'PURCHASE_REQUEST',
  amount: { netSatang: B(45000), vatSatang: 0n },
  requesterMemberId: 'req_con',
  chargedDepartmentId: 'CON',
  conflictMemberIds: ['req_con'],
  at: submitAt,
  ...over,
})
const threeSteps: DoaRuleSnapshot = {
  code: 'S',
  documentType: 'PURCHASE_REQUEST',
  priority: 1,
  when: {},
  steps: [
    { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
    { approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' },
    { approver: { kind: 'POSITION_OF_ORG', position: 'CEO' }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' },
  ],
}
const version = (): DoaVersionSnapshot => ({ ...v1(), rules: [threeSteps, ...v1().rules.filter((r) => r.documentType !== 'PURCHASE_REQUEST')] })
const delegation = (delegatorMemberId: string, delegateMemberId: string): DelegationSnapshot => ({
  id: `D-${delegatorMemberId}`,
  delegatorMemberId,
  delegateMemberId,
  startsAt: new Date('2026-10-05T00:00:00+07:00'),
  endsAt: new Date('2026-10-10T00:00:00+07:00'),
  documentTypes: null,
  maxAmountSatang: null,
  status: 'ACTIVE',
})
const route = (delegations: DelegationSnapshot[]) => {
  const made = resolveRoute(input(), { versions: [version()], org: orgSnapshot(), delegations })
  if (!made.ok) throw new Error(made.error.code)
  return made.data
}
const startAt = (at: Date, delegations: DelegationSnapshot[], doaStepNo: number, ruleCode = 'S') => {
  const now = activateStep(input(), version(), orgSnapshot(), delegations, at, ruleCode)
  if (!now.ok) throw new Error(now.error.code)
  return stepOfRoute(now.data, ruleCode, doaStepNo)
}

describe('[BR-WF-14] [BR-WF-06] a waiting step finds its own step of the route\'s rule', () => {
  it('a route keeps each step\'s place in the rule after repeated approvers merged (BR-DOA-07)', () => {
    // the VP delegated to the DM at the submit: DM and VP are one person, so the route keeps the VP's step
    const made = route([delegation('vp_ops', 'dm_con')])
    expect(made.steps.map((s) => [s.stepNo, s.ruleStepNo, s.assigneeMemberId, s.principalMemberId])).toEqual([
      [1, 2, 'dm_con', 'vp_ops'],
      [2, 3, 'ceo', null],
    ])
    expect(route([]).steps.map((s) => [s.stepNo, s.ruleStepNo])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  it('merged at the submit, apart at the start: the stored CEO step still goes to the CEO, not to the VP', () => {
    const made = route([delegation('vp_ops', 'dm_con')])
    const ceoStep = made.steps[1]!
    // the delegation has ended by the time step 2 starts: DM, VP and CEO are three people again
    const step = startAt(laterAt, [delegation('vp_ops', 'dm_con')], ceoStep.ruleStepNo)
    expect(step).toMatchObject({ ruleStepNo: 3, assigneeMemberId: 'ceo' })
  })

  it('apart at the submit, merged at the start: each stored step keeps its own holder, nobody is lost', () => {
    const made = route([])
    // the VP delegates to the DM after the submit: step 2 goes to the DM for the VP, step 3 still to the CEO
    expect(startAt(submitAt, [delegation('vp_ops', 'dm_con')], made.steps[1]!.ruleStepNo)).toMatchObject({ ruleStepNo: 2, assigneeMemberId: 'dm_con', principalMemberId: 'vp_ops' })
    expect(startAt(submitAt, [delegation('vp_ops', 'dm_con')], made.steps[2]!.ruleStepNo)).toMatchObject({ ruleStepNo: 3, assigneeMemberId: 'ceo' })
    // the CEO delegates to the VP: the VP's own step is not merged into the CEO's at the start
    expect(startAt(submitAt, [delegation('ceo', 'vp_ops')], 2)).toMatchObject({ ruleStepNo: 2, assigneeMemberId: 'vp_ops', principalMemberId: null })
  })

  it('a route escalated at its submit keeps its band when the conflict is gone; a conflict at the start moves it up', () => {
    const v = v1()
    const pr = v.rules.find((r) => r.code === 'PR-02')!
    // the route was made on PR-03 (the VP asked); PR-02 is what the amount would choose with nobody in conflict
    const kept = activateStep(input(), v, orgSnapshot(), [], laterAt, 'PR-03')
    expect(kept.ok && [kept.data.ruleCode, kept.data.steps.map((s) => s.assigneeMemberId)]).toEqual(['PR-03', ['ceo']])
    expect(kept.ok && stepOfRoute(kept.data, 'PR-03', 1)?.assigneeMemberId).toBe('ceo')
    // the holder of the route's own rule conflicts now: the band above, its last step
    const moved = activateStep(input({ conflictMemberIds: ['req_con', 'vp_ops'] }), v, orgSnapshot(), [], laterAt, pr.code)
    expect(moved.ok && moved.data.ruleCode).toBe('PR-03')
    expect(moved.ok && stepOfRoute(moved.data, pr.code, 1)?.assigneeMemberId).toBe('ceo')
  })

  it('a rule code the version does not have for the document type is NO_RULE; without one the amount chooses', () => {
    expect(resolveRoute(input(), { versions: [v1()], org: orgSnapshot(), delegations: [] }, { ruleCode: 'NOPE' })).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'NO_RULE' } } })
    expect(resolveRoute(input(), { versions: [v1()], org: orgSnapshot(), delegations: [] }, { ruleCode: 'PO-01' })).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED' } })
    const chosen = activateStep(input(), v1(), orgSnapshot(), [], laterAt)
    expect(chosen.ok && chosen.data.ruleCode).toBe('PR-02')
  })

  it('a route found again with merging (the KPI check) gives a merged step the step it merged into', () => {
    const merged = route([delegation('vp_ops', 'dm_con')])
    expect(stepOfRoute(merged, 'S', 1)).toMatchObject({ ruleStepNo: 2, assigneeMemberId: 'dm_con' })
  })
})
