import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { covers, delegateFor, inEffect, validateNewDelegation } from '@/core/delegation'
import {
  bandOf,
  bandTextTh,
  boundaryTable,
  chooseRule,
  departmentPath,
  inBand,
  lintDoaVersion,
  resolveApprover,
  resolveRoute,
  versionAt,
  type DelegationSnapshot,
  type DoaRuleSnapshot,
  type DoaVersionSnapshot,
  type OrgSnapshot,
  type RouteInput,
} from '@/core/doa'
import { higherBandLowers, whenMatches } from '@/core/doa/band'
import { anyHolderAt, holderAt, rootDepartment } from '@/core/doa/approvers'
import { explainRouteTh } from '@/core/doa/explain'
import { orgSnapshot, versionSnapshots } from '../golden/doa-fixtures'

// Branches of core/doa and core/delegation that the golden cases do not reach (spec §7.0 rule 4: 100% branch coverage),
// the BR-DOA-10 explanation text, and INV-DOA-02 (same input, same result) as a property test.

const B = (baht: number) => BigInt(Math.round(baht * 100))
const v1 = () => versionSnapshots().find((v) => v.versionNo === 1)!
const at = new Date('2026-10-06T03:00:00Z')
const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  documentType: 'PURCHASE_REQUEST',
  amount: { netSatang: B(45000), vatSatang: 0n },
  requesterMemberId: 'req_con',
  chargedDepartmentId: 'CON',
  conflictMemberIds: ['req_con'],
  at,
  ...over,
})
const policy = (over: { versions?: DoaVersionSnapshot[]; org?: OrgSnapshot; delegations?: DelegationSnapshot[] } = {}) => ({
  versions: over.versions ?? [v1()],
  org: over.org ?? orgSnapshot(),
  delegations: over.delegations ?? [],
})
const rule = (code: string, over: Partial<DoaRuleSnapshot> = {}): DoaRuleSnapshot => ({
  code,
  documentType: 'PURCHASE_REQUEST',
  priority: 100,
  when: {},
  steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' }],
  ...over,
})
const withRules = (rules: readonly DoaRuleSnapshot[], over: Partial<DoaVersionSnapshot> = {}): DoaVersionSnapshot => ({ ...v1(), rules, ...over })
const delegation = (over: Partial<DelegationSnapshot> = {}): DelegationSnapshot => ({
  id: 'D',
  delegatorMemberId: 'dm_con',
  delegateMemberId: 'asst_con',
  startsAt: new Date('2026-10-05T00:00:00+07:00'),
  endsAt: new Date('2026-10-10T00:00:00+07:00'),
  documentTypes: null,
  maxAmountSatang: null,
  status: 'ACTIVE',
  ...over,
})

describe('[FR-DOA-003/AC1] amount bands and rule choice (BR-DOA-02, BR-DOA-03)', () => {
  it('reads gt, gte and lte as (lower, upper] in satang', () => {
    expect(bandOf({ gte: B(100) })).toEqual({ lower: B(100) - 1n, upper: null })
    expect(bandOf({ lte: B(5) })).toEqual({ lower: null, upper: B(5) })
    expect(inBand(B(100), bandOf({ gte: B(100) }))).toBe(true)
    expect(inBand(B(5), { lower: null, upper: B(5) })).toBe(true)
    expect(inBand(B(5) + 1n, { lower: null, upper: B(5) })).toBe(false)
    expect(whenMatches({ amount: { gt: 0n } }, null)).toBe(false)
  })

  it('ranks by priority, then by the number of conditions, and reports a tie as ambiguous', () => {
    const narrow = rule('A', { priority: 10, when: { amount: { gt: 0n, lte: B(10) } } })
    const general = rule('B', { priority: 10 })
    expect(chooseRule(withRules([general, narrow]), 'PURCHASE_REQUEST', B(5))).toEqual({ kind: 'rule', rule: narrow })
    const twin = rule('C', { priority: 10, when: { amount: { gt: 0n, lte: B(20) } } })
    expect(chooseRule(withRules([narrow, twin]), 'PURCHASE_REQUEST', B(5))).toMatchObject({ kind: 'ambiguous' })
    expect(chooseRule(withRules([narrow]), 'PURCHASE_ORDER', B(5))).toEqual({ kind: 'none' })
    expect(chooseRule(withRules([narrow, general]), 'PURCHASE_REQUEST', B(5), (r) => r.code === 'B')).toEqual({ kind: 'rule', rule: general })
  })

  it('lists the higher bands above a lower bound, skipping bands without one', () => {
    const version = withRules([rule('A', { when: { amount: { lte: B(10) } } }), rule('B', { when: { amount: { gt: B(10), lte: B(20) } } }), rule('C', { when: { amount: { gt: B(20) } } })])
    expect(higherBandLowers(version, 'PURCHASE_REQUEST', null)).toEqual([B(10), B(20)])
    expect(higherBandLowers(version, 'PURCHASE_REQUEST', B(10))).toEqual([B(20)])
    expect(higherBandLowers(version, 'PURCHASE_ORDER', null)).toEqual([])
    // Bands listed from the top down come out in order as well
    const reversed = withRules([...version.rules].reverse())
    expect(higherBandLowers(reversed, 'PURCHASE_REQUEST', null)).toEqual([B(10), B(20)])
    expect(boundaryTable(reversed, 'PURCHASE_REQUEST').map((r) => r.ruleCode)).toEqual(['A', 'B', 'B', 'C'])
  })
})

describe('[FR-DOA-003/AC1] approvers (BR-DOA-04, BR-DOA-05)', () => {
  it('walks up from the charged department and stops at the root; a loop in the data cannot hang it', () => {
    const org = orgSnapshot()
    expect(departmentPath(org, 'CON').map((d) => d.code)).toEqual(['CON', 'OPS', 'HQ'])
    const looped: OrgSnapshot = { ...org, departments: [{ id: 'X', code: 'X', nameTh: 'x', parentId: 'Y' }, { id: 'Y', code: 'Y', nameTh: 'y', parentId: 'X' }] }
    expect(departmentPath(looped, 'X').map((d) => d.code)).toEqual(['X', 'Y'])
    expect(departmentPath(org, 'NOPE')).toEqual([])
  })

  it('treats a holder outside its dates or a deactivated holder as vacant', () => {
    const org = orgSnapshot()
    const ended: OrgSnapshot = { ...org, holders: org.holders.map((h) => (h.memberId === 'dm_con' ? { ...h, validTo: new Date('2026-01-01T00:00:00Z') } : h)) }
    expect(holderAt(ended, 'DM', 'CON', at)).toBeNull()
    const future: OrgSnapshot = { ...org, holders: org.holders.map((h) => (h.memberId === 'dm_con' ? { ...h, validFrom: new Date('2027-01-01T00:00:00Z') } : h)) }
    expect(holderAt(future, 'DM', 'CON', at)).toBeNull()
    const inactive: OrgSnapshot = { ...org, members: org.members.map((m) => (m.id === 'dm_con' ? { ...m, active: false } : m)) }
    expect(holderAt(inactive, 'DM', 'CON', at)).toBeNull()
    const unknown: OrgSnapshot = { ...org, members: org.members.filter((m) => m.id !== 'dm_con') }
    expect(holderAt(unknown, 'DM', 'CON', at)).toBeNull()
    expect(anyHolderAt(org, 'DM', at)).toBe(true)
    expect(anyHolderAt(org, 'CFO', at)).toBe(false)
  })

  it('finds a named member only while active, and an organization position only at the root', () => {
    const org = orgSnapshot()
    expect(resolveApprover({ kind: 'MEMBER', memberId: 'coo' }, 'CON', org, at)).toMatchObject({ found: true, memberId: 'coo', resolvedFrom: 'MEMBER:coo', viaPosition: false })
    const inactive: OrgSnapshot = { ...org, members: org.members.map((m) => (m.id === 'coo' ? { ...m, active: false } : m)) }
    expect(resolveApprover({ kind: 'MEMBER', memberId: 'coo' }, 'CON', inactive, at)).toEqual({ found: false, position: 'MEMBER:coo', departments: [] })
    const noRoot: OrgSnapshot = { ...org, departments: org.departments.filter((d) => d.parentId !== null) }
    expect(rootDepartment(noRoot)).toBeNull()
    expect(resolveApprover({ kind: 'POSITION_OF_ORG', position: 'CEO' }, 'CON', noRoot, at)).toEqual({ found: false, position: 'CEO', departments: [] })
  })
})

describe('[FR-DOA-003/AC1] resolveRoute paths beyond the golden cases', () => {
  it('needs an amount for purchase documents and checks it on the version basis', () => {
    expect(resolveRoute(input({ amount: undefined }), policy())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'AMOUNT_REQUIRED' } } })
    const net = withRules(v1().rules, { amountBasis: 'NET' })
    expect(resolveRoute(input({ amount: { netSatang: 0n, vatSatang: B(7) } }), policy({ versions: [net] }))).toMatchObject({ ok: false, error: { details: { reason: 'AMOUNT_NOT_POSITIVE' } } })
  })

  it('uses PUBLISHED or SUPERSEDED versions inside their dates only', () => {
    const superseded = { ...v1(), status: 'SUPERSEDED' as const, effectiveTo: new Date('2026-10-05T00:00:00Z') }
    expect(versionAt([superseded], at)).toBeNull()
    expect(versionAt([{ ...v1(), status: 'DRAFT' }], at)).toBeNull()
    const second = { ...v1(), id: 'v1b', versionNo: 2 }
    expect(versionAt([v1(), second], at)?.id).toBe('v1b')
  })

  it('reports no rule and ambiguous rules', () => {
    expect(resolveRoute(input(), policy({ versions: [withRules([])] }))).toMatchObject({ ok: false, error: { code: 'DOA_NOT_CONFIGURED', details: { reason: 'NO_RULE' } } })
    const a = rule('A')
    const b = rule('B')
    expect(resolveRoute(input(), policy({ versions: [withRules([a, b])] }))).toMatchObject({ ok: false, error: { code: 'DOA_AMBIGUOUS', details: { rules: ['A', 'B'] } } })
  })

  it('refuses at once under the BLOCK policy (BR-DOA-06)', () => {
    const blocked = withRules(v1().rules, { selfApprovalPolicy: 'BLOCK' })
    expect(resolveRoute(input({ requesterMemberId: 'vp_ops', chargedDepartmentId: 'OPS', conflictMemberIds: ['vp_ops'] }), policy({ versions: [blocked] }))).toMatchObject({
      ok: false,
      error: { code: 'SOD_VIOLATION', details: { rule: 'BR-DOA-06', ruleCode: 'PR-02' } },
    })
  })

  it('cannot escalate a rule without an amount band, and reports a missing approver in the higher band', () => {
    expect(resolveRoute(input({ documentType: 'DOA_CHANGE', amount: undefined, requesterMemberId: 'ceo', conflictMemberIds: ['ceo'] }), policy())).toMatchObject({
      ok: false,
      error: { code: 'NO_HIGHER_AUTHORITY', details: { ruleCode: 'DOA-CHG-01' } },
    })
    const org = orgSnapshot(['CEO@HQ'])
    expect(resolveRoute(input({ requesterMemberId: 'vp_ops', chargedDepartmentId: 'OPS', conflictMemberIds: ['vp_ops'] }), policy({ org }))).toMatchObject({
      ok: false,
      error: { code: 'APPROVER_NOT_FOUND', details: { ruleCode: 'PR-03', position: 'CEO', departments: ['HQ'] } },
    })
  })

  it('reports an ambiguous higher band', () => {
    const rules = [rule('L', { when: { amount: { gt: 0n, lte: B(100) } } }), rule('H1', { when: { amount: { gt: B(100) } } }), rule('H2', { when: { amount: { gt: B(100) } } })]
    expect(resolveRoute(input({ amount: { netSatang: B(50), vatSatang: 0n }, requesterMemberId: 'dm_con', conflictMemberIds: ['dm_con'] }), policy({ versions: [withRules(rules)] }))).toMatchObject({
      ok: false,
      error: { code: 'DOA_AMBIGUOUS', details: { rules: ['H1', 'H2'] } },
    })
  })

  it('keeps the later of two consecutive steps with the same approver only when the version says so (BR-DOA-07)', () => {
    const steps = [
      { approver: { kind: 'POSITION_OF_DEPARTMENT' as const, position: 'DM' }, slaBusinessMinutes: 480, mode: 'SEQUENTIAL' as const },
      { approver: { kind: 'MEMBER' as const, memberId: 'dm_con' }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' as const },
      { approver: { kind: 'POSITION_OF_ORG' as const, position: 'CEO' }, slaBusinessMinutes: 960, mode: 'SEQUENTIAL' as const },
    ]
    const two = [rule('S', { steps })]
    const collapsed = resolveRoute(input(), policy({ versions: [withRules(two)] }))
    expect(collapsed.ok && collapsed.data.steps.map((s) => [s.stepNo, s.assigneeMemberId, s.slaBusinessMinutes])).toEqual([
      [1, 'dm_con', 960],
      [2, 'ceo', 960],
    ])
    const kept = resolveRoute(input(), policy({ versions: [withRules(two, { collapseDuplicateApprovers: false })] }))
    expect(kept.ok && kept.data.steps.map((s) => s.assigneeMemberId)).toEqual(['dm_con', 'dm_con', 'ceo'])
  })

  it('explains the route in Thai exactly as BR-DOA-10 shows', () => {
    const route = resolveRoute(input(), policy())
    expect(route.ok && route.data.explanationTh).toBe(
      'DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 45,000.00 บาท (รวม VAT) อยู่ในช่วงมากกว่า 20,000.00 ถึงไม่เกิน 100,000.00 → VP ของสายปฏิบัติการ',
    )
  })

  it('explains escalation, delegation, organization positions and documents without an amount', () => {
    const escalated = resolveRoute(input({ amount: { netSatang: B(15000), vatSatang: 0n }, requesterMemberId: 'dm_con', conflictMemberIds: ['dm_con'] }), policy())
    expect(escalated.ok && escalated.data.explanationTh).toBe(
      'DOA-DEMO ฉบับ 1 ข้อ PR-02: คำขอซื้อยอด 15,000.00 บาท (รวม VAT) อยู่ในช่วงไม่เกิน 20,000.00 ของข้อ PR-01 → DM ของฝ่ายก่อสร้าง มีส่วนเกี่ยวข้องกับเอกสารนี้ จึงยกไปข้อ PR-02 ของช่วงวงเงินถัดไป → VP ของสายปฏิบัติการ',
    )
    const delegated = resolveRoute(input({ amount: { netSatang: B(10000), vatSatang: 0n } }), policy({ delegations: [delegation()] }))
    expect(delegated.ok && delegated.data.explanationTh).toContain('→ DM ของฝ่ายก่อสร้าง (asst_con รักษาการแทน dm_con)')
    const governance = resolveRoute(input({ documentType: 'ORG_AUTHORITY_CHANGE', amount: undefined, requesterMemberId: 'admin', chargedDepartmentId: 'IT', conflictMemberIds: ['admin'] }), policy())
    expect(governance.ok && governance.data.explanationTh).toBe('DOA-DEMO ฉบับ 1 ข้อ ORG-CHG-01: การเปลี่ยนโครงสร้างอำนาจ → CEO')
    const net = resolveRoute(input(), policy({ versions: [withRules(v1().rules, { amountBasis: 'NET' })] }))
    expect(net.ok && net.data.explanationTh).toContain('(ก่อน VAT)')
    const member = resolveRoute(input(), policy({ versions: [withRules([rule('M', { steps: [{ approver: { kind: 'MEMBER', memberId: 'coo' }, slaBusinessMinutes: 60, mode: 'SEQUENTIAL' }] })])] }))
    expect(member.ok && member.data.explanationTh).toBe('DOA-DEMO ฉบับ 1 ข้อ M: คำขอซื้อยอด 45,000.00 บาท (รวม VAT) → coo')
  })

  it('falls back to codes and ids when a department or member is missing from the snapshot', () => {
    const empty: OrgSnapshot = { departments: [], holders: [], members: [] }
    const text = explainRouteTh({
      version: v1(),
      documentType: 'PURCHASE_REQUEST',
      basisAmount: B(1),
      amountBasis: 'GROSS',
      rule: rule('X'),
      escalatedFrom: null,
      steps: [
        { resolvedFrom: 'POSITION:DM@GONE', assigneeMemberId: 'a', principalMemberId: null },
        { resolvedFrom: 'MEMBER:b', assigneeMemberId: 'b', principalMemberId: 'c' },
      ],
      org: empty,
    })
    expect(text).toBe('DOA-DEMO ฉบับ 1 ข้อ X: คำขอซื้อยอด 1.00 บาท (รวม VAT) → DM ของGONE → b (b รักษาการแทน c)')
  })

  it('writes band text for every shape of band', () => {
    expect(bandTextTh(rule('X', { when: { amount: { gt: B(10) } } }))).toBe('อยู่ในช่วงมากกว่า 10.00')
    expect(bandTextTh(rule('X', { when: { amount: { lte: B(10) } } }))).toBe('อยู่ในช่วงไม่เกิน 10.00')
    expect(bandTextTh(rule('X', { when: { amount: { gt: 0n } } }))).toBeNull()
    expect(bandTextTh(rule('X'))).toBeNull()
  })
})

describe('[FR-DOA-006/AC1] delegation rules beyond the golden cases (BR-DLG-01 to BR-DLG-05)', () => {
  const ctx = { documentType: 'PURCHASE_REQUEST' as const, basisAmountSatang: B(5000), at, conflictMemberIds: ['req_con'] }

  it('limits by document type and by amount; a cap never covers a document without an amount', () => {
    expect(covers(delegation({ documentTypes: ['PURCHASE_ORDER'] }), ctx)).toBe(false)
    expect(covers(delegation({ documentTypes: ['PURCHASE_REQUEST'] }), ctx)).toBe(true)
    expect(covers(delegation({ documentTypes: [] }), ctx)).toBe(true)
    expect(covers(delegation({ maxAmountSatang: B(5000) }), ctx)).toBe(true)
    expect(covers(delegation({ maxAmountSatang: B(5000) }), { ...ctx, documentType: 'DOA_CHANGE', basisAmountSatang: null })).toBe(false)
    expect(covers(delegation(), { ...ctx, documentType: 'DOA_CHANGE', basisAmountSatang: null })).toBe(true)
  })

  it('is in effect from startsAt up to, not including, endsAt, unless revoked', () => {
    const d = delegation()
    expect(inEffect(d, d.startsAt)).toBe(true)
    expect(inEffect(d, d.endsAt)).toBe(false)
    expect(inEffect(delegation({ status: 'REVOKED' }), at)).toBe(false)
  })

  it('never delegates a named member, never to oneself, and picks the latest start if periods ever overlap', () => {
    expect(delegateFor({ memberId: 'dm_con', viaPosition: false }, ctx, [delegation()])).toEqual({ assigneeMemberId: 'dm_con', principalMemberId: null, notifyOrgAdmin: false })
    expect(delegateFor({ memberId: 'dm_con', viaPosition: true }, ctx, [delegation({ delegateMemberId: 'dm_con' })]).assigneeMemberId).toBe('dm_con')
    const early = delegation({ id: 'E', delegateMemberId: 'asst_con' })
    const late = delegation({ id: 'L', delegateMemberId: 'receiver_con', startsAt: new Date('2026-10-06T00:00:00+07:00') })
    expect(delegateFor({ memberId: 'dm_con', viaPosition: true }, ctx, [early, late]).assigneeMemberId).toBe('receiver_con')
    const sameStart = delegation({ id: 'A', delegateMemberId: 'receiver_con' })
    expect(delegateFor({ memberId: 'dm_con', viaPosition: true }, ctx, [early, sameStart]).assigneeMemberId).toBe('receiver_con')
    expect(delegateFor({ memberId: 'dm_con', viaPosition: true }, ctx, [sameStart, early]).assigneeMemberId).toBe('receiver_con')
  })

  it('refuses bad periods, amounts, self-delegation and inactive delegates; ignores revoked and ended periods', () => {
    const org = orgSnapshot()
    const base = { delegatorMemberId: 'dm_con', delegateMemberId: 'asst_con', startsAt: new Date('2026-10-20T00:00:00+07:00'), endsAt: new Date('2026-10-22T00:00:00+07:00'), documentTypes: null, maxAmountSatang: null }
    expect(validateNewDelegation({ ...base, endsAt: base.startsAt }, [], org)).toBe('INVALID_PERIOD')
    expect(validateNewDelegation({ ...base, maxAmountSatang: 0n }, [], org)).toBe('INVALID_AMOUNT')
    expect(validateNewDelegation({ ...base, delegateMemberId: 'dm_con' }, [], org)).toBe('SELF_DELEGATION')
    expect(validateNewDelegation({ ...base, delegateMemberId: 'nobody' }, [], org)).toBe('DELEGATE_NOT_ACTIVE')
    const ended = { ...org, holders: org.holders.map((h) => (h.memberId === 'dm_con' ? { ...h, validTo: new Date('2026-10-01T00:00:00Z') } : h)) }
    expect(validateNewDelegation(base, [], ended)).toBe('NOTHING_TO_DELEGATE')
    const overlapping = delegation({ startsAt: new Date('2026-10-21T00:00:00+07:00'), endsAt: new Date('2026-10-25T00:00:00+07:00') })
    expect(validateNewDelegation(base, [overlapping], org)).toBe('OVERLAPPING_DELEGATION')
    expect(validateNewDelegation(base, [{ ...overlapping, status: 'REVOKED' }, { ...overlapping, status: 'ENDED' }, { ...overlapping, delegatorMemberId: 'dm_it' }], org)).toBeNull()
  })
})

describe('[FR-DOA-002/AC1] lint beyond the golden cases (BR-DOA-08)', () => {
  const org = orgSnapshot()
  const lint = (rules: DoaRuleSnapshot[], o: OrgSnapshot = org) => lintDoaVersion(withRules([...rules, ...v1().rules.filter((r) => r.documentType === 'DOA_CHANGE' || r.documentType === 'ORG_AUTHORITY_CHANGE')]), o, at)

  it('finds an open end, a band from below zero and overlaps after an open band', () => {
    expect(lint([rule('A', { when: { amount: { gt: 0n, lte: B(10) } } })]).errors).toEqual([{ code: 'DOA_LINT_GAP', documentType: 'PURCHASE_REQUEST', gt: B(10), lte: null }])
    expect(lint([rule('A', { when: { amount: { lte: B(10) } } }), rule('B', { when: { amount: { gt: B(10) } } })]).errors).toEqual([])
    expect(lint([rule('A', { when: { amount: { gt: 0n } } }), rule('B', { when: { amount: { gt: B(10) } } })]).errors).toEqual([{ code: 'DOA_LINT_OVERLAP', documentType: 'PURCHASE_REQUEST', gt: B(10), lte: null }])
    expect(lint([rule('A', { when: { amount: { gt: 0n } } }), rule('B', { when: { amount: { lte: B(5) } } })]).errors).toEqual([{ code: 'DOA_LINT_OVERLAP', documentType: 'PURCHASE_REQUEST', gt: 0n, lte: B(5) }])
    expect(lint([rule('A', { when: { amount: { lte: B(10) } } }), rule('B', { when: { amount: { lte: B(5) } } }), rule('C', { when: { amount: { gt: B(10) } } })]).errors).toEqual([
      { code: 'DOA_LINT_OVERLAP', documentType: 'PURCHASE_REQUEST', gt: 0n, lte: B(5) },
    ])
  })

  it('refuses PARALLEL steps, warns about named members and vacant positions anywhere, and needs a root', () => {
    const parallel = rule('P', { when: { amount: { gt: 0n } }, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'CEO' }, slaBusinessMinutes: 60, mode: 'PARALLEL' }] })
    expect(lint([parallel]).errors).toEqual([{ code: 'DOA_LINT_PARALLEL_STEP', rule: 'P' }])
    const cfo = rule('F', { when: { amount: { gt: 0n } }, steps: [{ approver: { kind: 'POSITION_OF_DEPARTMENT', position: 'CFO' }, slaBusinessMinutes: 60, mode: 'SEQUENTIAL' }] })
    expect(lint([cfo]).warnings).toEqual([{ code: 'DOA_LINT_VACANT_POSITION', rule: 'F' }])
    const memberGovernance = rule('G', { documentType: 'DOA_CHANGE', steps: [{ approver: { kind: 'MEMBER', memberId: 'ceo' }, slaBusinessMinutes: 60, mode: 'SEQUENTIAL' }] })
    expect(lintDoaVersion(withRules([memberGovernance, ...v1().rules.filter((r) => r.documentType === 'ORG_AUTHORITY_CHANGE')]), org, at).warnings).toEqual([{ code: 'DOA_LINT_MEMBER_APPROVER', rule: 'G' }])
    const noRoot: OrgSnapshot = { ...org, departments: org.departments.filter((d) => d.parentId !== null) }
    const result = lint([rule('R', { when: { amount: { gt: 0n } }, steps: [{ approver: { kind: 'POSITION_OF_ORG', position: 'COO' }, slaBusinessMinutes: 60, mode: 'SEQUENTIAL' }] })], noRoot)
    expect(result.errors.map((e) => e.code)).toEqual(['DOA_LINT_UNRESOLVABLE_GOVERNANCE', 'DOA_LINT_UNRESOLVABLE_GOVERNANCE'])
    expect(result.warnings).toEqual([{ code: 'DOA_LINT_VACANT_POSITION', rule: 'R' }])
  })

  it('marks an ambiguous boundary with no rule', () => {
    const rows = boundaryTable(withRules([rule('A', { when: { amount: { gt: 0n, lte: B(10) } } }), rule('B', { when: { amount: { gt: 0n, lte: B(10) } } })]), 'PURCHASE_REQUEST')
    expect(rows).toEqual([
      { amountSatang: B(10), ruleCode: null },
      { amountSatang: B(10) + 1n, ruleCode: null },
    ])
  })
})

describe('[INV-DOA-02] resolveRoute gives the same result for the same input and snapshots', () => {
  const people = ['req_con', 'dm_con', 'vp_ops', 'ceo', 'coo', 'proc_officer', 'admin']
  const departments = ['CON', 'PROC', 'OPS', 'FIN', 'IT', 'SUP', 'HQ']
  const versions = versionSnapshots()
  const org = orgSnapshot()
  it('is deterministic and never routes to a conflicting approver', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 300_000_000n }),
        fc.constantFrom(...people),
        fc.constantFrom(...departments),
        fc.constantFrom('PURCHASE_REQUEST' as const, 'PURCHASE_ORDER' as const),
        fc.integer({ min: 0, max: 60 }),
        (amount, requester, department, documentType, day) => {
          const when = new Date(Date.UTC(2026, 9, 1 + day, 3))
          const run = () =>
            resolveRoute(
              { documentType, amount: { netSatang: amount, vatSatang: 0n }, requesterMemberId: requester, chargedDepartmentId: department, conflictMemberIds: [requester], at: when },
              { versions, org, delegations: [] },
            )
          const first = run()
          expect(run()).toEqual(first)
          if (first.ok) {
            for (const step of first.data.steps) expect(step.assigneeMemberId).not.toBe(requester)
            const used = first.data.escalatedFromRuleCode ?? first.data.ruleCode
            const version = versions.find((v) => v.versionNo === first.data.versionNo)!
            const band = version.rules.find((r) => r.code === used)!.when.amount!
            expect(inBand(amount, bandOf(band))).toBe(true)
          }
        },
      ),
      { numRuns: 1000 },
    )
  })
})
