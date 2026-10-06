import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DOA_BOUNDARY_SECTION, boundaryTickOf, doaComparison } from '@/app/(workspace)/_tracking/policy-subject'
import type { ApproverSpec, DoaRuleSnapshot, DoaWhen } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { ruleJson } from '@/server/doa/snapshot'
import { getTaskView, type PolicySubjectDto, type TaskViewDto } from '@/server/queries/tasks'
import { decideTask } from '@/server/services/approvals/decide'
import { submitDoaVersion } from '@/server/services/doa'
import { boundaryTablesOf } from '@/server/services/doa/boundary'
import { draftDoaCopy, getDoaEditor, type DoaEditorView, type DraftCopyInput } from '@/server/services/doa/editor'
import { submitInitialPackage } from '@/server/services/doa/initial-package'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp } from '../support/pin'

// S3-09 · the decision page of a DOA_VERSION task reads the version beside the one it is compared with — the version in
// effect just before it starts, as the drafter's page, the send and the approval read it (comparisonBaselineId) — so the
// boundary table the approver ticks is the one the approval checks, and the tick names that version (FR-DOA-009 AC1,
// AC3); the version in effect now still counts the open tasks that keep their route (BR-DOA-13). Once published it is
// read beside the version it replaced. An organization's first version shows its own table; a version without band
// edges has none, and the page then asks for no tick. Real Postgres; organizations of the §7.4 fixture (createDoaOrg).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const baht = (text: string) => amountToSatang(text).toString()
const CEO_SECRET = 'V'.repeat(32)

const DM: ApproverSpec = { kind: 'POSITION_OF_DEPARTMENT', position: 'DM' }
const VP: ApproverSpec = { kind: 'POSITION_OF_DEPARTMENT', position: 'VP' }
const COO: ApproverSpec = { kind: 'POSITION_OF_ORG', position: 'COO' }
const CEO: ApproverSpec = { kind: 'POSITION_OF_ORG', position: 'CEO' }
const rule = (code: string, documentType: DoaRuleSnapshot['documentType'], when: DoaWhen, approver: ApproverSpec, minutes = 480): DoaRuleSnapshot => ({
  code,
  documentType,
  priority: 100,
  when,
  steps: [{ approver, slaBusinessMinutes: minutes, mode: 'SEQUENTIAL' }],
})
/** A version whose bands have no upper end */
const FLAT: DoaRuleSnapshot[] = [
  rule('PR-01', 'PURCHASE_REQUEST', { amount: { gt: 0n } }, DM),
  rule('PO-01', 'PURCHASE_ORDER', { amount: { gt: 0n } }, COO),
  rule('GRV-01', 'GR_VARIANCE', {}, DM),
  rule('DOA-CHG-01', 'DOA_CHANGE', {}, CEO, 960),
  rule('ORG-CHG-01', 'ORG_AUTHORITY_CHANGE', {}, CEO, 960),
]

async function orgWithCeo(options: { doa?: boolean } = {}): Promise<DoaOrg> {
  const org = await createDoaOrg(options)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  return org
}

async function storeVersion(org: DoaOrg, versionNo: number, status: 'PUBLISHED' | 'DRAFT', effectiveFrom: Date, rules: ReadonlyArray<DoaRuleSnapshot>): Promise<string> {
  const version = await prisma.doaVersion.create({
    data: {
      organizationId: org.organizationId,
      code: 'DOA-DEMO',
      versionNo,
      status,
      effectiveFrom,
      amountBasis: 'GROSS',
      selfApprovalPolicy: 'ESCALATE_NEXT_BAND',
      collapseDuplicateApprovers: true,
      stepUpThresholdSatang: 10_000_000n,
      escalationPolicy: { remindPct: 0.5, escalateAfterBusinessHours: 8 },
      sodPolicy: { approverMayReceive: false, requesterMayReceive: true },
      ...(status === 'PUBLISHED' ? { publishedAt: effectiveFrom } : {}),
    },
  })
  for (const r of rules) {
    const json = ruleJson(r)
    await prisma.doaRule.create({ data: { organizationId: org.organizationId, doaVersionId: version.id, code: r.code, documentType: json.documentType, priority: r.priority, when: json.when, steps: json.steps } })
  }
  return version.id
}

async function editor(org: DoaOrg, versionId: string): Promise<DoaEditorView> {
  const r = await getDoaEditor(org.ctxOf('admin', NOW), versionId)
  if (!r.ok) throw new Error(`editor failed: ${JSON.stringify(r.error)}`)
  return r.data
}

const ruleOf = (input: DraftCopyInput, code: string) => input.rules.find((r) => r.code === code)!

/** A draft saved from `sourceId` through the editor, sent (with the drafter's tick when it has a table); returns it and its task */
async function sent(org: DoaOrg, sourceId: string, edit: (input: DraftCopyInput) => void, tick = true) {
  const view = await editor(org, sourceId)
  const input: DraftCopyInput = {
    sourceVersionId: view.source.id,
    effectiveDate: view.defaultEffectiveDate,
    changeReason: 'ปรับผู้อนุมัติ',
    policy: { ...view.policy },
    rules: view.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band ? { ...r.band } : null, steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })) })),
  }
  edit(input)
  const saved = await draftDoaCopy(org.ctxOf('admin', NOW), input, key())
  if (!saved.ok) throw new Error(`draft failed: ${JSON.stringify(saved.error)}`)
  const versionId = saved.data.versionId
  const submitted = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId, ...(tick ? { boundaryTableConfirmed: true } : {}) }, key())
  if (!submitted.ok) throw new Error(`submit failed: ${JSON.stringify(submitted.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: versionId } } } })
  return { versionId, taskId: task.id }
}

/** The CEO approves with a step-up and the tick of the boundary table, at `at`; `tick`: what the page sends with it */
async function approve(org: DoaOrg, versionId: string, taskId: string, at = NOW, tick: { boundaryBaselineId?: string | null } = {}) {
  await pinStepUp(org.organizationId, org.member.ceo!, 'DOA_VERSION', versionId)
  const decided = await decideTask(org.ctxOf('ceo', at), { taskId, decision: 'APPROVE', boundaryTableConfirmed: true, ...tick }, key())
  if (!decided.ok) throw new Error(`approval failed: ${JSON.stringify(decided.error)}`)
}

async function taskView(org: DoaOrg, taskId: string, at = NOW): Promise<{ view: TaskViewDto; policy: Extract<PolicySubjectDto, { kind: 'DOA_VERSION' }> }> {
  const view = await getTaskView(org.ctxOf('ceo', at), taskId)
  if (view?.policy?.kind !== 'DOA_VERSION') throw new Error('not a DOA version task')
  return { view, policy: view.policy }
}

/** The boundary table the approval checks (src/server/services/doa/boundary.ts), at `at` */
async function approvalTable(org: DoaOrg, versionId: string, at = NOW) {
  return forTenant(org.organizationId).$transaction(async (tx) => boundaryTablesOf(tx, await tx.doaVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: true } }), at))
}

const v1Of = async (org: DoaOrg) => (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id
const who = (a: ApproverSpec) => (a.kind === 'MEMBER' ? a.memberId : a.position)

describe('[FR-DOA-009/AC3] the decision page reads a DOA version beside the version it replaces', () => {
  it('with version 2 approved for 1 November, version 3 for 1 December is read beside version 2, and its table is the one the approval checks', async () => {
    const org = await orgWithCeo()
    const v1 = await v1Of(org)
    const second = await sent(org, v1, (i) => {
      ruleOf(i, 'PR-01').band!.upper = baht('30000.00')
      ruleOf(i, 'PR-02').band!.lower = baht('30000.00')
    })
    await approve(org, second.versionId, second.taskId)
    // Approved, version 2 is still read beside version 1, in effect until it starts: the comparison its approver ticked
    const decided = await taskView(org, second.taskId)
    expect(decided.view.status).toBe('APPROVED')
    expect(decided.policy).toMatchObject({ status: 'PUBLISHED', current: { versionId: v1 }, baseline: { versionId: v1, relation: 'IN_EFFECT' } })
    expect(doaComparison(decided.policy)!.boundaries.find((t) => t.documentType === 'PURCHASE_REQUEST')!.rows.filter((r) => r.changed).map((r) => r.amount)).toEqual([baht('20000.01'), baht('30000.00')])

    // Version 3 from version 2: the COO's orders go to the CEO; it starts on 1 December
    const third = await sent(org, second.versionId, (i) => (ruleOf(i, 'PO-01').steps[0]!.approver = CEO))

    const { view, policy } = await taskView(org, third.taskId)
    // Version 1 is in effect now and keeps its open tasks (BR-DOA-13); version 3 replaces version 2
    expect(policy.current).toMatchObject({ versionId: v1, versionNo: 1 })
    expect(policy.baseline).toEqual({ versionId: second.versionId, code: 'DOA-DEMO', versionNo: 2, effectiveFrom: new Date('2026-10-31T17:00:00Z'), relation: 'NEXT' })
    expect(policy.baselineContent).toMatchObject({ code: 'DOA-DEMO', versionNo: 2 })
    const comparison = doaComparison(policy)!
    expect(comparison.authority.map((c) => [c.change, who(c.approver), c.documentType])).toEqual([
      ['GAIN', 'CEO', 'PURCHASE_ORDER'],
      ['LOSE', 'COO', 'PURCHASE_ORDER'],
    ])
    expect(comparison.basis).toBeNull()
    // The page's table is the approval's, row for row: version 2's band edges, none of which changes
    expect(comparison.boundaries).toEqual(await approvalTable(org, third.versionId))
    const pr = comparison.boundaries.find((t) => t.documentType === 'PURCHASE_REQUEST')!
    expect(pr.rows.map((r) => [r.amount, r.before?.ruleCode, r.after.ruleCode, r.changed])).toEqual([
      [baht('30000.00'), 'PR-01', 'PR-01', false],
      [baht('30000.01'), 'PR-02', 'PR-02', false],
      [baht('100000.00'), 'PR-02', 'PR-02', false],
      [baht('100000.01'), 'PR-03', 'PR-03', false],
    ])
    // The approve form ticks that table, naming version 2 as the version it compares with
    const tick = boundaryTickOf(view)
    expect(tick).toEqual({ tableId: DOA_BOUNDARY_SECTION, baselineId: second.versionId })

    // The CEO approves with the page's tick: version 3 is published for 1 December, after version 2 (ADR-042 item 7)
    await approve(org, third.versionId, third.taskId, NOW, { boundaryBaselineId: tick!.baselineId })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: third.versionId } })).toMatchObject({ status: 'PUBLISHED', effectiveFrom: new Date('2026-11-30T17:00:00Z'), effectiveTo: null })
  })

  it('a version whose start passed before its approval is read beside the version in effect, and once published beside the one it replaced', async () => {
    const org = await orgWithCeo()
    const v1 = await v1Of(org)
    const later = new Date('2026-10-07T03:00:00Z')
    // Version 2 for 6 October, approved on 7 October: the approval moves its start to the approval (BR-DOA-12)
    const second = await sent(org, v1, (i) => {
      ruleOf(i, 'PR-01').band!.upper = baht('30000.00')
      ruleOf(i, 'PR-02').band!.lower = baht('30000.00')
      i.effectiveDate = '2026-10-06'
    })
    const waiting = await taskView(org, second.taskId, later)
    expect(waiting.policy.baseline).toMatchObject({ versionId: v1, relation: 'IN_EFFECT' })
    expect(doaComparison(waiting.policy)!.boundaries).toEqual(await approvalTable(org, second.versionId, later))
    expect(boundaryTickOf(waiting.view)).toEqual({ tableId: DOA_BOUNDARY_SECTION, baselineId: v1 })

    await approve(org, second.versionId, second.taskId, later, { boundaryBaselineId: v1 })
    const published = await taskView(org, second.taskId, later)
    expect(published.policy).toMatchObject({ status: 'PUBLISHED', effectiveFrom: later, current: null })
    expect(published.policy.baseline).toMatchObject({ versionId: v1, versionNo: 1, relation: 'REPLACED' })
    expect(doaComparison(published.policy)!.authority.map((c) => [c.change, who(c.approver)])).toEqual([
      ['GAIN', 'DM'],
      ['LOSE', 'VP'],
    ])
  })

  it('an organization’s first version has nothing to compare with: the page shows its own table, which the signatory ticks', async () => {
    const org = await orgWithCeo({ doa: false })
    await prisma.organization.update({ where: { id: org.organizationId }, data: { contractSignatoryMemberId: org.member.ceo!, contractSignatoryVerifiedAt: NOW } })
    const versionId = await storeVersion(org, 1, 'DRAFT', new Date('2026-10-10T00:00:00+07:00'), versionSnapshots()[0]!.rules)
    const fixture = loadYaml<{ positions: Array<{ position: string; department: string; member: string }> }>('fixtures/org-demo.yaml')
    const named = new Set(['DM', 'VP', 'COO', 'CEO'])
    const holders = fixture.positions.filter((p) => named.has(p.position)).map((p) => ({ positionCode: p.position, departmentId: org.department[p.department]!, memberId: org.member[p.member]! }))
    const submitted = await submitInitialPackage(org.ctxOf('admin', NOW), { versionId, holders, reason: 'ชุดตั้งต้นตามสัญญา', boundaryTableConfirmed: true }, key())
    if (!submitted.ok) throw new Error(`package failed: ${JSON.stringify(submitted.error)}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId: submitted.data.routeId } } })

    const { view, policy } = await taskView(org, task.id)
    expect(policy).toMatchObject({ current: null, baseline: null, baselineContent: null })
    const comparison = doaComparison(policy)!
    expect(comparison.authority).toEqual([])
    const pr = comparison.boundaries.find((t) => t.documentType === 'PURCHASE_REQUEST')!
    // GC-DOA-22, with the approver each rule names
    expect(pr.rows.map((r) => [r.amount, r.before, r.after.ruleCode, r.after.approvers.map(who)])).toEqual([
      [baht('20000.00'), null, 'PR-01', ['DM']],
      [baht('20000.01'), null, 'PR-02', ['VP']],
      [baht('100000.00'), null, 'PR-02', ['VP']],
      [baht('100000.01'), null, 'PR-03', ['CEO']],
    ])
    expect(comparison.boundaries).toEqual(await approvalTable(org, versionId))
    // Its own table: the tick names no version to compare with
    expect(boundaryTickOf(view)).toEqual({ tableId: DOA_BOUNDARY_SECTION, baselineId: null })
  })

  it('a version without a band edge gives the page no table, so the approve form asks for no tick', async () => {
    const org = await orgWithCeo({ doa: false })
    const v1 = await storeVersion(org, 1, 'PUBLISHED', new Date('2026-01-01T00:00:00+07:00'), FLAT)
    const second = await sent(org, v1, (i) => (ruleOf(i, 'PR-01').steps[0]!.approver = VP), false)
    const { view, policy } = await taskView(org, second.taskId)
    expect(policy.baseline).toMatchObject({ versionId: v1, relation: 'IN_EFFECT' })
    const comparison = doaComparison(policy)!
    expect(comparison.boundaries).toEqual([])
    expect(comparison.authority.map((c) => [c.change, who(c.approver), c.documentType, c.band])).toEqual([
      ['GAIN', 'VP', 'PURCHASE_REQUEST', { gt: '0', lte: null }],
      ['LOSE', 'DM', 'PURCHASE_REQUEST', { gt: '0', lte: null }],
    ])
    expect(boundaryTickOf(view)).toBeNull()
    // A request task never has one either
    expect(boundaryTickOf({ ...view, policy: null })).toBeNull()
  })
})
