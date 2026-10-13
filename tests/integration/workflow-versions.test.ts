import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { decideTask } from '@/server/services/approvals/decide'
import { outsideChannels } from '@/server/services/approvals/subjects'
import { activateWorkflowVersion, draftWorkflowVersion, dryRunWorkflowVersion, submitWorkflowVersion, updateWorkflowVersion } from '@/server/services/workflow'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'
import { pinStepUp } from '../support/pin'

// S6-04 (FR-WF-103 AC2 AC3, BR-WF-11 BR-WF-12): the life of a workflow version against Postgres — a draft copied from
// the version in effect, edited (which asks for a new dry-run), tried out beside the version in effect, refused while
// the lint has an error, a test case fails, a warning is not ticked or the dry-run did not run, then sent to the
// approver of DOA_CHANGE, who decides on the web only and with a step-up; published for its date, it supersedes the
// version before it when the job runs then. The organization is the §7.4 fixture with the S6 departments (org-s6).

const NOW = new Date('2026-10-06T03:00:00Z')
const LATER = new Date('2026-10-06T04:00:00Z')
const NOV_1 = new Date('2026-10-31T17:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const POS = (position: string, department: string) => ({ kind: 'POSITION_AT' as const, position, department })
type RuleIn = Parameters<typeof updateWorkflowVersion>[1]['rules'][number]
const rule = (code: string, over: Partial<RuleIn> = {}): RuleIn => ({
  code,
  requestTypeCodes: ['BUY_GOODS'],
  when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY'] },
  reviewers: [POS('DM', 'QSE')],
  fallback: POS('VP', 'OPS'),
  mode: 'ALL',
  quorumCount: null,
  slaMinutes: 480,
  ...over,
})

let org: DoaOrg
let v1: string
beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // Version 1 in effect since 1 October: safety goods go to the DM of QSE
  const version = await prisma.workflowVersion.create({ data: { organizationId: org.organizationId, code: 'WF-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-09-30T17:00:00Z'), publishedAt: NOW } })
  await prisma.workflowRule.create({
    data: { organizationId: org.organizationId, workflowVersionId: version.id, code: 'RV-1', requestTypeCodes: ['BUY_GOODS'], when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY'] }, reviewers: [POS('DM', 'QSE')], fallback: POS('VP', 'OPS'), mode: 'ALL', slaBusinessMinutes: 480, sortOrder: 0 },
  })
  v1 = version.id
})

const admin = () => org.ctxOf('admin', NOW)
const update = (versionId: string, version: number, rules: RuleIn[], testCases: Parameters<typeof updateWorkflowVersion>[1]['testCases'] = []) =>
  updateWorkflowVersion(admin(), { versionId, version, effectiveDate: '2026-11-01', changeReason: 'เพิ่มผู้ตรวจของน้ำมัน', rules, testCases }, key())
const dryRun = (versionId: string) =>
  dryRunWorkflowVersion(admin(), { versionId, documents: [{ requestType: 'BUY_GOODS', amountGross: '5000.00', lineCategories: ['FUEL'], requesterMemberId: org.member.req_con!, chargedDepartmentId: org.department.CON! }] }, key())
const row = (id: string) => prisma.workflowVersion.findUniqueOrThrow({ where: { id } })

/** A draft of version 1 with RV-2 (fuel goes to the DM of PROC), dry-run and ready to send */
async function readyDraft(rules: RuleIn[] = [rule('RV-1'), rule('RV-2', { when: { field: '$lineCategories', op: 'anyIn', value: ['FUEL'] }, reviewers: [POS('DM', 'PROC')] })]) {
  const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
  const { version } = ok(await update(versionId, (await row(versionId)).version, rules))
  ok(await dryRun(versionId))
  return { versionId, version }
}

describe('[FR-WF-103/AC1] a draft is a copy of the version it starts from', () => {
  it('copies the rules under the next number and leaves the source as it was; members without the capability are refused', async () => {
    const { versionId, versionNo, code } = ok(await draftWorkflowVersion(admin(), {}, key()))
    expect([code, versionNo]).toEqual(['WF-T', expect.any(Number)])
    const draft = await prisma.workflowVersion.findUniqueOrThrow({ where: { id: versionId }, include: { rules: true } })
    expect(draft).toMatchObject({ status: 'DRAFT', dryRunAt: null })
    expect(draft.rules.map((r) => r.code)).toEqual(['RV-1'])
    expect(await row(v1)).toMatchObject({ status: 'PUBLISHED' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'workflow_version.drafted', aggregateId: versionId } })).toMatchObject({ data: { via: 'COPY', fromVersionId: v1, rules: 1 } })
    expect(await draftWorkflowVersion(org.ctxOf('req_con', NOW), {}, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-WF-103/AC2] the dry-run and the checks before sending (BR-WF-11)', () => {
  it('the dry-run shows the version in effect beside the draft; a change asks for it again', async () => {
    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    const { version } = ok(await update(versionId, (await row(versionId)).version, [rule('RV-1'), rule('RV-2', { when: { field: '$lineCategories', op: 'anyIn', value: ['FUEL'] }, reviewers: [POS('DM', 'PROC')] })]))
    expect(await row(versionId)).toMatchObject({ dryRunAt: null })
    expect(await submitWorkflowVersion(admin(), { versionId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'DRY_RUN_REQUIRED' } } })

    const { rows } = ok(await dryRun(versionId))
    expect(rows).toEqual([
      {
        current: { ok: true, review: null, approval: { ruleCode: 'PR-01', memberIds: [org.member.dm_con] }, error: null },
        draft: { ok: true, review: [{ ruleCodes: ['RV-2'], memberIds: [org.member.dm_proc] }], approval: { ruleCode: 'PR-01', memberIds: [org.member.dm_con] }, error: null },
        changed: true,
      },
    ])
    expect(await row(versionId)).toMatchObject({ dryRunAt: NOW })
    // Editing the draft again clears the dry-run
    ok(await update(versionId, version, [rule('RV-1')]))
    expect(await row(versionId)).toMatchObject({ dryRunAt: null })
  })

  it('a lint error refuses the send with WORKFLOW_LINT_FAILED; a warning must be ticked', async () => {
    const lintError = await readyDraft([rule('RV-1'), rule('RV-9', { requestTypeCodes: ['NO_SUCH_TYPE'] })])
    expect(await submitWorkflowVersion(admin(), { versionId: lintError.versionId }, key())).toMatchObject({ ok: false, error: { code: 'WORKFLOW_LINT_FAILED', details: { codes: 'WF_LINT_UNKNOWN_REQUEST_TYPE' } } })
    const warning = await readyDraft([rule('RV-1', { fallback: null })])
    expect(await submitWorkflowVersion(admin(), { versionId: warning.versionId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'WARNINGS_NOT_ACKNOWLEDGED', warnings: ['WF_LINT_NO_FALLBACK:RV-1'] } } })
    expect(await submitWorkflowVersion(admin(), { versionId: warning.versionId, acknowledgedWarnings: ['WF_LINT_NO_FALLBACK:RV-1'] }, key())).toMatchObject({ ok: true })
  })

  it('a test case that does not give its rules refuses the send', async () => {
    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    const testCases = [{ name: 'น้ำมันต้องไปฝ่ายจัดซื้อ', input: { requestType: 'BUY_GOODS', amountGross: '5000.00', lineCategories: ['FUEL'], budgetAccountCodes: [], fields: {} }, expected: { ruleCodes: ['RV-2'] } }]
    ok(await update(versionId, (await row(versionId)).version, [rule('RV-1')], testCases))
    ok(await dryRun(versionId))
    expect(await submitWorkflowVersion(admin(), { versionId }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TEST_CASES_FAILED', testCases: ['น้ำมันต้องไปฝ่ายจัดซื้อ'] } } })
  })

  it('an effective date in the past is refused when the draft is saved', async () => {
    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    expect(
      await updateWorkflowVersion(admin(), { versionId, version: (await row(versionId)).version, effectiveDate: '2026-10-01', changeReason: 'ย้อนหลัง', rules: [rule('RV-1')], testCases: [] }, key()),
    ).toMatchObject({ ok: false, error: { details: { field: 'effectiveDate', reason: 'EFFECTIVE_IN_PAST' } } })
  })
})

describe('[FR-WF-103/AC3] approval under DOA_CHANGE with a step-up, on the web only (BR-WF-12)', () => {
  it('the submitter cannot be the approver; the CEO decides with the PIN; it takes effect on its date', async () => {
    // The CEO as ORG_ADMIN cannot send it to themself: nobody above the CEO can approve
    await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.ceo!, role: 'ORG_ADMIN', grantedAt: NOW } })
    const own = await readyDraft()
    expect(await submitWorkflowVersion(org.ctxOf('ceo', NOW), { versionId: own.versionId }, key())).toMatchObject({ ok: false, error: { code: 'NO_HIGHER_AUTHORITY' } })

    const { versionId } = await readyDraft()
    const sent = ok(await submitWorkflowVersion(admin(), { versionId }, key()))
    expect(sent.assigneeMemberId).toBe(org.member.ceo)
    expect(await row(versionId)).toMatchObject({ status: 'PENDING_APPROVAL', submittedById: org.member.admin })
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'WORKFLOW_VERSION', subjectId: versionId } } } })
    // No button in the chat, no link in the e-mail, no LIFF
    expect(await forTenant(org.organizationId).$transaction((tx) => outsideChannels(tx, 'WORKFLOW_VERSION', versionId))).toEqual({ chatButton: false, emailLink: false })
    expect(await prisma.actionToken.count({ where: { taskId: task.id } })).toBe(0)
    expect(await decideTask(org.ctxOf('ceo', LATER, 'LIFF'), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'CHANNEL' } } })
    // Every decision takes the step-up, whatever the amount (ALWAYS_STEP_UP_SUBJECTS)
    expect(await decideTask(org.ctxOf('ceo', LATER), { taskId: task.id, decision: 'APPROVE' }, key())).toMatchObject({ ok: false, error: { code: 'STEP_UP_REQUIRED' } })
    await pinStepUp(org.organizationId, org.member.ceo!, 'WORKFLOW_VERSION', versionId)
    expect(ok(await decideTask(org.ctxOf('ceo', LATER), { taskId: task.id, decision: 'APPROVE' }, key()))).toMatchObject({ documentStatus: 'PUBLISHED' })
    expect(await row(versionId)).toMatchObject({ status: 'PUBLISHED', effectiveFrom: NOV_1, approvedById: org.member.ceo })
    // Version 1 ends where it starts and stays PUBLISHED until then
    expect(await row(v1)).toMatchObject({ status: 'PUBLISHED', effectiveTo: NOV_1 })
    expect(await prisma.notification.count({ where: { templateKey: 'workflow_version.approved', recipientMemberId: org.member.admin } })).toBe(1)
    expect(await prisma.notification.count({ where: { templateKey: 'doa.authority_changed', subjectId: versionId } })).toBeGreaterThan(0)

    // The job at the effective date: not before it, then version 1 is SUPERSEDED
    expect(await activateWorkflowVersion(org.organizationId, versionId, LATER)).toMatchObject({ ok: false, error: { details: { reason: 'NOT_DUE' } } })
    ok(await activateWorkflowVersion(org.organizationId, versionId, NOV_1))
    expect(await row(v1)).toMatchObject({ status: 'SUPERSEDED' })
  })

  it('a rejection ends the version REJECTED and tells its submitter', async () => {
    const { versionId } = await readyDraft()
    // A version approved for 1 November already exists: a draft for the same date is refused, a later one goes
    const sameDay = await submitWorkflowVersion(admin(), { versionId }, key())
    expect(sameDay).toMatchObject({ ok: false, error: { details: { reason: 'LATER_VERSION_SCHEDULED' } } })
    ok(await updateWorkflowVersion(admin(), { versionId, version: (await row(versionId)).version, effectiveDate: '2026-12-01', changeReason: 'เดือนถัดไป', rules: [rule('RV-1')], testCases: [] }, key()))
    ok(await dryRun(versionId))
    ok(await submitWorkflowVersion(admin(), { versionId }, key()))
    const task = await prisma.approvalTask.findFirstOrThrow({ where: { status: 'OPEN', step: { route: { subjectType: 'WORKFLOW_VERSION', subjectId: versionId } } } })
    await pinStepUp(org.organizationId, org.member.ceo!, 'WORKFLOW_VERSION', versionId)
    expect(ok(await decideTask(org.ctxOf('ceo', LATER), { taskId: task.id, decision: 'REJECT', reason: 'ยังไม่ถึงเวลา' }, key()))).toMatchObject({ documentStatus: 'REJECTED' })
    expect(await row(versionId)).toMatchObject({ status: 'REJECTED' })
    expect(await prisma.event.findFirstOrThrow({ where: { type: 'workflow_version.rejected', aggregateId: versionId } })).toMatchObject({ data: { reasonCommentId: expect.any(String) } })
  })
})
