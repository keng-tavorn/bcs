import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decidePolicy } from '@/app/(workspace)/_tracking/commands'
import { DOA_BOUNDARY_SECTION, boundaryTickOf } from '@/app/(workspace)/_tracking/policy-subject'
import type { ApproverSpec, DoaRuleSnapshot, DoaWhen } from '@/core/doa'
import { amountToSatang } from '@/core/money/dto'
import { totp } from '@/lib/totp'
import { enableTotpWithSecret, upsertUserWithPassword } from '@/server/auth/provision'
import { grantStepUp } from '@/server/auth/step-up'
import { memberPrincipal } from '@/server/authz'
import { prisma } from '@/server/db/client'
import { ruleJson } from '@/server/doa/snapshot'
import { getTaskView } from '@/server/queries/tasks'
import { decideTask } from '@/server/services/approvals/decide'
import { submitDoaVersion } from '@/server/services/doa'
import { draftDoaCopy, getDoaEditor, type DoaEditorView, type DraftCopyInput } from '@/server/services/doa/editor'
import { submitInitialPackage } from '@/server/services/doa/initial-package'
import { proposeOrgChange } from '@/server/services/org-authority'
import { loadYaml, versionSnapshots } from '../golden/doa-fixtures'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S3-09 · the approver's half of FR-DOA-009 AC3: a DOA version is approved only once its approver ticks the boundary
// table as checked — the table of the version beside the one it replaces, which the drafter ticked to send it — and the
// service asks for the tick itself (BR-AUTH-05), before it uses the step-up (BR-DOA-15), so a refused approval leaves
// the grant for the one that follows; the decision event records the tick. The tick is of the table the page showed: it
// names the version that table compared with, and a version approved in between, which moves the comparison, makes the
// service refuse it (BOUNDARY_TABLE_CHANGED) until the approver ticks the table as it is now. Rejecting needs no tick; a
// version without a band edge has no table and nothing to tick; an organization's first version is ticked on its own
// table; authority changes are decided as before (FR-DOA-010 AC2). The decision page's command passes the tick, and an
// unticked page spends no code (FR-DOA-002 AC2: the approver's step-up). A version approved after one approved for
// later ends only that one's period (FR-DOA-002 AC4, ADR-042 item 7). Real Postgres; organizations of the §7.4 fixture
// (createDoaOrg).

const NOW = new Date('2026-10-05T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const baht = (text: string) => amountToSatang(text).toString()
const CEO_SECRET = 'T'.repeat(32)
const REFUSED = { ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' } } }
const CHANGED = { ok: false, error: { code: 'VALIDATION_FAILED', details: { field: 'boundaryTableConfirmed', reason: 'BOUNDARY_TABLE_CHANGED' } } }
/** 00:00 Thai time on 1 November and 1 December 2026 */
const NOV_1 = new Date('2026-10-31T17:00:00Z')
const DEC_1 = new Date('2026-11-30T17:00:00Z')

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

/** A version whose bands have no upper end: every purchase request goes to the DM, every order to the COO */
const FLAT: DoaRuleSnapshot[] = [
  rule('PR-01', 'PURCHASE_REQUEST', { amount: { gt: 0n } }, DM),
  rule('PO-01', 'PURCHASE_ORDER', { amount: { gt: 0n } }, COO),
  rule('GRV-01', 'GR_VARIANCE', {}, DM),
  rule('DOA-CHG-01', 'DOA_CHANGE', {}, CEO, 960),
  rule('ORG-CHG-01', 'ORG_AUTHORITY_CHANGE', {}, CEO, 960),
]

/** An organization of the fixture with its admin, and a CEO who signs in with an authenticator (the step-up) */
async function orgWithCeo(options: { doa?: boolean } = {}): Promise<DoaOrg> {
  const org = await createDoaOrg(options)
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  const ceo = await prisma.member.findUniqueOrThrow({ where: { id: org.member.ceo! } })
  const userId = await upsertUserWithPassword({ email: ceo.email, name: ceo.displayNameTh, password: 'ceo-password-123456' })
  await enableTotpWithSecret(userId, CEO_SECRET, [])
  await prisma.member.update({ where: { id: ceo.id }, data: { userId } })
  return org
}

/** A version stored as the seed stores one (local test data) */
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

/** What the editor page sends: the table as it was loaded, after `edit` */
function inputOf(view: DoaEditorView, edit: (input: DraftCopyInput) => void = () => undefined): DraftCopyInput {
  const input: DraftCopyInput = {
    sourceVersionId: view.source.id,
    effectiveDate: view.defaultEffectiveDate,
    changeReason: 'ขยายวงเงิน DM เป็น 30,000 บาท',
    policy: { ...view.policy },
    rules: view.rules.map((r) => ({ code: r.code, documentType: r.documentType, band: r.band ? { ...r.band } : null, steps: r.steps.map((s) => ({ approver: { ...s.approver }, slaMinutes: s.slaMinutes })) })),
  }
  edit(input)
  return input
}

const ruleOf = (input: DraftCopyInput, code: string) => input.rules.find((r) => r.code === code)!
/** The demo's change: the DM band ends at 30,000 and the VP band starts there */
const dmTo30k = (input: DraftCopyInput) => {
  ruleOf(input, 'PR-01').band!.upper = baht('30000.00')
  ruleOf(input, 'PR-02').band!.lower = baht('30000.00')
}

/** A draft saved from `sourceId` through the editor and sent with the drafter's tick; returns it and the CEO's task */
async function sent(org: DoaOrg, sourceId: string, edit: (input: DraftCopyInput) => void, tick: { boundaryTableConfirmed?: boolean } = { boundaryTableConfirmed: true }) {
  const saved = await draftDoaCopy(org.ctxOf('admin', NOW), inputOf(await editor(org, sourceId), edit), key())
  if (!saved.ok) throw new Error(`draft failed: ${JSON.stringify(saved.error)}`)
  const versionId = saved.data.versionId
  const submitted = await submitDoaVersion(org.ctxOf('admin', NOW), { versionId, ...tick }, key())
  if (!submitted.ok) throw new Error(`submit failed: ${JSON.stringify(submitted.error)}`)
  const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'DOA_VERSION', subjectId: versionId } } } })
  return { versionId, task }
}

/** The CEO's step-up for one document, on the security clock (real time), as the decision page gets it */
async function stepUp(org: DoaOrg, subjectType: 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE', subjectId: string): Promise<string> {
  const grant = await grantStepUp({ organizationId: org.organizationId, memberId: org.member.ceo!, subjectType, subjectId, code: totp(CEO_SECRET) }, new Date())
  if (!grant.ok) throw new Error(`step-up refused: ${grant.reason}`)
  return grant.grantId
}

const decidedEvent = (taskId: string) => prisma.event.findFirst({ where: { aggregateType: 'ApprovalTask', aggregateId: taskId, type: 'approval_task.decided' } })
const v1Of = async (org: DoaOrg) => (await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, versionNo: 1 } })).id

/** Another change: the COO's purchase orders go to the CEO, from `date` */
const cooToCeoFrom = (date: string) => (input: DraftCopyInput) => {
  ruleOf(input, 'PO-01').steps[0]!.approver = CEO
  input.effectiveDate = date
}

/** What the CEO's decision page of the task sends with the tick: its boundary table, and the version it compares with */
async function pageTick(org: DoaOrg, taskId: string) {
  const view = await getTaskView(org.ctxOf('ceo', NOW), taskId)
  if (!view) throw new Error('the CEO cannot read the task')
  return boundaryTickOf(view)
}

describe('[FR-DOA-009/AC3] the approver ticks the boundary table before approving a DOA version', () => {
  it('an approval without the tick is refused before the step-up is used; with it the version is published and the decision records the tick', async () => {
    const org = await orgWithCeo()
    const { versionId, task } = await sent(org, await v1Of(org), dmTo30k)
    const grant = await stepUp(org, 'DOA_VERSION', versionId)

    // An approval that leaves the tick out, or sends it unticked, is refused (BR-AUTH-05: the service asks itself)
    for (const tick of [{}, { boundaryTableConfirmed: false }]) {
      expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', ...tick }, key())).toMatchObject(REFUSED)
    }
    // Nothing moved, and the step-up is still there for the approval with the tick
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: grant } })).toMatchObject({ usedAt: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: 'OPEN', decidedAt: null })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: versionId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(await decidedEvent(task.id)).toBeNull()

    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: grant } })).toMatchObject({ usedAt: expect.any(Date) })
    expect(await decidedEvent(task.id)).toMatchObject({
      actorMemberId: org.member.ceo,
      doaRuleCode: 'DOA-CHG-01',
      data: { decision: 'APPROVE', subjectType: 'DOA_VERSION', subjectId: versionId, channel: 'WEB', stepUpGrantId: grant, boundaryTableConfirmed: true },
    })
  })

  it('without a step-up the ticked approval still asks for the code (BR-DOA-15)', async () => {
    const org = await orgWithCeo()
    const { task } = await sent(org, await v1Of(org), dmTo30k)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
  })

  it('rejecting needs no tick: the version is rejected with the reason, and the decision records no tick', async () => {
    const org = await orgWithCeo()
    const { versionId, task } = await sent(org, await v1Of(org), dmTo30k)
    await stepUp(org, 'DOA_VERSION', versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'REJECT', reason: 'ขอทบทวนวงเงินก่อน' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'REJECTED' } })
    const decided = await decidedEvent(task.id)
    expect(decided).toMatchObject({ data: { decision: 'REJECT', subjectType: 'DOA_VERSION', subjectId: versionId, reasonCommentId: expect.any(String) } })
    expect(decided!.data).not.toHaveProperty('boundaryTableConfirmed')
  })

  it('a version without a band edge has no boundary table, and is approved without a tick', async () => {
    const org = await orgWithCeo({ doa: false })
    const v1 = await storeVersion(org, 1, 'PUBLISHED', new Date('2026-01-01T00:00:00+07:00'), FLAT)
    // Purchase requests of every amount go to the VP instead of the DM: authority moves, yet no band has an edge
    const { versionId, task } = await sent(org, v1, (i) => (ruleOf(i, 'PR-01').steps[0]!.approver = VP), {})
    await stepUp(org, 'DOA_VERSION', versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect((await decidedEvent(task.id))!.data).not.toHaveProperty('boundaryTableConfirmed')
  })

  it('an organization’s first version has no version to compare with: its signatory ticks the version’s own table', async () => {
    const org = await orgWithCeo({ doa: false })
    await prisma.organization.update({ where: { id: org.organizationId }, data: { contractSignatoryMemberId: org.member.ceo!, contractSignatoryVerifiedAt: NOW } })
    // Version 1 of the fixture has the band edges of GC-DOA-22
    const versionId = await storeVersion(org, 1, 'DRAFT', new Date('2026-10-10T00:00:00+07:00'), versionSnapshots()[0]!.rules)
    const fixture = loadYaml<{ positions: Array<{ position: string; department: string; member: string }> }>('fixtures/org-demo.yaml')
    const named = new Set(['DM', 'VP', 'COO', 'CEO'])
    const holders = fixture.positions.filter((p) => named.has(p.position)).map((p) => ({ positionCode: p.position, departmentId: org.department[p.department]!, memberId: org.member[p.member]! }))
    const submitted = await submitInitialPackage(org.ctxOf('admin', NOW), { versionId, holders, reason: 'ชุดตั้งต้นตามสัญญา', boundaryTableConfirmed: true }, key())
    if (!submitted.ok) throw new Error(`package failed: ${JSON.stringify(submitted.error)}`)
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { routeId: submitted.data.routeId } } })
    const grant = await stepUp(org, 'DOA_VERSION', versionId)

    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject(REFUSED)
    // A tick of a table beside some version is not a tick of this one, which stands alone
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true, boundaryBaselineId: randomUUID() }, key())).toMatchObject(CHANGED)
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: grant } })).toMatchObject({ usedAt: null })
    // The page's tick of the version's own table names no version to compare with
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: task.id, decision: 'APPROVE', boundaryTableConfirmed: true, boundaryBaselineId: null }, key())).toMatchObject({
      ok: true,
      data: { documentStatus: 'PUBLISHED' },
    })
    expect(await decidedEvent(task.id)).toMatchObject({ data: { stepUpGrantId: grant, boundaryTableConfirmed: true } })
  })
})

describe('[FR-DOA-010/AC2] an authority change has no boundary table: it is decided with a step-up and no tick, as before', () => {
  it('approves an appointment without a tick, and records none even when one is sent', async () => {
    const org = await orgWithCeo()
    const propose = async (department: string, member: string) => {
      const proposed = await proposeOrgChange(
        org.ctxOf('admin', NOW),
        { kind: 'POSITION_ASSIGN', payload: { positionCode: 'DM', departmentId: org.department[department]!, memberId: org.member[member]! }, effectiveFrom: '2026-12-01T01:00:00Z', reason: 'แต่งตั้งตามคำสั่งบริษัท' },
        key(),
      )
      if (!proposed.ok) throw new Error(`propose failed: ${JSON.stringify(proposed.error)}`)
      const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'ORG_AUTHORITY_CHANGE', subjectId: proposed.data.changeId } } } })
      await stepUp(org, 'ORG_AUTHORITY_CHANGE', proposed.data.changeId)
      return task
    }
    const plain = await propose('FIN', 'fin_officer')
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: plain.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: true, data: { documentStatus: 'SCHEDULED' } })
    expect((await decidedEvent(plain.id))!.data).not.toHaveProperty('boundaryTableConfirmed')
    const ticked = await propose('IT', 'admin2')
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: ticked.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'SCHEDULED' } })
    expect((await decidedEvent(ticked.id))!.data).not.toHaveProperty('boundaryTableConfirmed')
  })
})

describe('[FR-DOA-009/AC3] [FR-DOA-002/AC2] the decision page passes the approver’s tick with the code', () => {
  it('an unticked page spends no code; a page without the table is refused by the service; the ticked page approves', async () => {
    const org = await orgWithCeo()
    const { versionId, task } = await sent(org, await v1Of(org), dmTo30k)
    const ceo = memberPrincipal(org.member.ceo!, ['EXECUTIVE'])
    const decide = (boundaryTableConfirmed: boolean | null) => decidePolicy(org.ctxOf('ceo', NOW), ceo, { taskId: task.id, decision: 'APPROVE', code: totp(CEO_SECRET), boundaryTableConfirmed }, randomUUID(), 'th', new Date())
    const grants = () => prisma.stepUpGrant.count({ where: { organizationId: org.organizationId, subjectId: versionId } })

    // The page showed the table and it was not ticked: told before the code is checked, so no step-up is granted
    expect(await decide(false)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' })
    expect(await grants()).toBe(0)
    // A page that showed no table sends no tick: the service asks for it all the same, and its grant stays unused
    expect(await decide(null)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'boundaryTableConfirmed', reason: 'BOUNDARY_NOT_CONFIRMED' })
    expect(await prisma.stepUpGrant.count({ where: { organizationId: org.organizationId, subjectId: versionId, usedAt: null } })).toBe(1)
    expect((await prisma.approvalTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('OPEN')

    expect(await decide(true)).toEqual({ ok: true, documentStatus: 'PUBLISHED' })
    expect(await decidedEvent(task.id)).toMatchObject({ data: { decision: 'APPROVE', boundaryTableConfirmed: true } })
  })

  it('a rejection from the page needs no tick', async () => {
    const org = await orgWithCeo()
    const { task } = await sent(org, await v1Of(org), dmTo30k)
    const ceo = memberPrincipal(org.member.ceo!, ['EXECUTIVE'])
    expect(await decidePolicy(org.ctxOf('ceo', NOW), ceo, { taskId: task.id, decision: 'REJECT', reason: 'ขอทบทวนวงเงินก่อน', code: totp(CEO_SECRET), boundaryTableConfirmed: false }, randomUUID(), 'th', new Date())).toEqual({
      ok: true,
      documentStatus: 'REJECTED',
    })
  })
})

describe('[FR-DOA-009/AC3] the approver’s tick is of the table the page showed: a version approved in between makes it stale', () => {
  it('version 3 ticked beside version 1 is refused once version 2 is approved before it, and the step-up stays; ticked beside version 2 it is approved', async () => {
    const org = await orgWithCeo()
    const v1 = await v1Of(org)
    // Version 2 (the DM up to 30,000, from 1 November) and version 3 (the COO's orders to the CEO, from 1 December) wait together
    const second = await sent(org, v1, dmTo30k)
    const third = await sent(org, v1, cooToCeoFrom('2026-12-01'))
    // The CEO opens version 3: its table is beside version 1, the version in effect just before 1 December
    const opened = await pageTick(org, third.task.id)
    expect(opened).toEqual({ tableId: DOA_BOUNDARY_SECTION, baselineId: v1 })

    // Meanwhile version 2 is approved for 1 November: version 3 now replaces version 2, and its table is another one
    await stepUp(org, 'DOA_VERSION', second.versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: second.task.id, decision: 'APPROVE', boundaryTableConfirmed: true, boundaryBaselineId: v1 }, key())).toMatchObject({
      ok: true,
      data: { documentStatus: 'PUBLISHED' },
    })

    // The tick of the page opened before is refused before the step-up is used, and nothing moves
    const grant = await stepUp(org, 'DOA_VERSION', third.versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: third.task.id, decision: 'APPROVE', boundaryTableConfirmed: true, boundaryBaselineId: opened!.baselineId }, key())).toMatchObject(CHANGED)
    expect(await prisma.stepUpGrant.findUniqueOrThrow({ where: { id: grant } })).toMatchObject({ usedAt: null })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: third.task.id } })).toMatchObject({ status: 'OPEN', decidedAt: null })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: third.versionId } })).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect(await decidedEvent(third.task.id)).toBeNull()

    // The decision page's command passes the page's version: the same refusal, with the words for it
    const ceo = memberPrincipal(org.member.ceo!, ['EXECUTIVE'])
    const decide = (boundaryBaselineId: string | null) =>
      decidePolicy(org.ctxOf('ceo', NOW), ceo, { taskId: third.task.id, decision: 'APPROVE', code: totp(CEO_SECRET), boundaryTableConfirmed: true, boundaryBaselineId }, randomUUID(), 'th', new Date())
    expect(await decide(v1)).toEqual({ ok: false, code: 'VALIDATION_FAILED', field: 'boundaryTableConfirmed', reason: 'BOUNDARY_TABLE_CHANGED' })
    expect(await prisma.approvalTask.findUniqueOrThrow({ where: { id: third.task.id } })).toMatchObject({ status: 'OPEN' })

    // The page read again shows version 3 beside version 2; its tick approves, and version 3 starts after version 2
    const reread = await pageTick(org, third.task.id)
    expect(reread).toEqual({ tableId: DOA_BOUNDARY_SECTION, baselineId: second.versionId })
    expect(await decide(reread!.baselineId)).toEqual({ ok: true, documentStatus: 'PUBLISHED' })
    expect(await decidedEvent(third.task.id)).toMatchObject({ data: { decision: 'APPROVE', subjectId: third.versionId, boundaryTableConfirmed: true } })
    expect(await prisma.doaVersion.findUniqueOrThrow({ where: { id: third.versionId } })).toMatchObject({ status: 'PUBLISHED', effectiveFrom: DEC_1, effectiveTo: null })
  })
})

describe('[FR-DOA-002/AC4] a version approved after one approved for later ends only the period that reaches past its start', () => {
  const period = (id: string) => prisma.doaVersion.findUniqueOrThrow({ where: { id }, select: { status: true, effectiveFrom: true, effectiveTo: true } })

  /** Version 1 in effect, and version 2 (the DM up to 30,000) approved for 1 November */
  async function secondApprovedForLater(org: DoaOrg) {
    const v1 = await v1Of(org)
    const v1Start = (await period(v1)).effectiveFrom
    const second = await sent(org, v1, dmTo30k)
    await stepUp(org, 'DOA_VERSION', second.versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: second.task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })
    expect(await period(v1)).toEqual({ status: 'PUBLISHED', effectiveFrom: v1Start, effectiveTo: NOV_1 })
    return { v1, v1Start, second }
  }

  it('version 3 for 1 December: version 2 ends on 1 December and version 1 keeps its end on 1 November', async () => {
    const org = await orgWithCeo()
    const { v1, v1Start, second } = await secondApprovedForLater(org)
    const third = await sent(org, second.versionId, cooToCeoFrom('2026-12-01'))
    await stepUp(org, 'DOA_VERSION', third.versionId)
    expect(await decideTask(org.ctxOf('ceo', NOW), { taskId: third.task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({ ok: true, data: { documentStatus: 'PUBLISHED' } })

    // One period after another, never overlapping (doa_no_overlap); none is superseded before its successor starts,
    // when the job doa-version-activate supersedes it (NEW-13)
    expect(await period(v1)).toEqual({ status: 'PUBLISHED', effectiveFrom: v1Start, effectiveTo: NOV_1 })
    expect(await period(second.versionId)).toEqual({ status: 'PUBLISHED', effectiveFrom: NOV_1, effectiveTo: DEC_1 })
    expect(await period(third.versionId)).toEqual({ status: 'PUBLISHED', effectiveFrom: DEC_1, effectiveTo: null })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'doa_version.superseded' } })).toBe(0)
  })

  it('version 3 for 10 November approved on 15 November: it starts at the approval, version 2 ends and is superseded then, version 1 keeps its end', async () => {
    const org = await orgWithCeo()
    const { v1, v1Start, second } = await secondApprovedForLater(org)
    const third = await sent(org, second.versionId, cooToCeoFrom('2026-11-10'))
    const approvedAt = new Date('2026-11-15T03:00:00Z')
    await stepUp(org, 'DOA_VERSION', third.versionId)
    expect(await decideTask(org.ctxOf('ceo', approvedAt), { taskId: third.task.id, decision: 'APPROVE', boundaryTableConfirmed: true }, key())).toMatchObject({
      ok: true,
      data: { documentStatus: 'PUBLISHED' },
    })

    // BR-DOA-12: a start that has passed becomes the approval; version 1 ended on 1 November and is left to the job
    expect(await period(v1)).toEqual({ status: 'PUBLISHED', effectiveFrom: v1Start, effectiveTo: NOV_1 })
    expect(await period(second.versionId)).toEqual({ status: 'SUPERSEDED', effectiveFrom: NOV_1, effectiveTo: approvedAt })
    expect(await period(third.versionId)).toEqual({ status: 'PUBLISHED', effectiveFrom: approvedAt, effectiveTo: null })
    const superseded = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'doa_version.superseded' }, select: { aggregateId: true, data: true } })
    expect(superseded).toEqual([{ aggregateId: second.versionId, data: { code: 'DOA-DEMO', versionNo: 2, supersededBy: third.versionId } }])
  })
})
