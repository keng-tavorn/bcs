import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { draftWorkflowVersion, dryRunWorkflowVersion, submitWorkflowVersion, updateWorkflowVersion } from '@/server/services/workflow'
import { diffWorkflowRules, getWorkflowEditor, listWorkflowVersions, type WorkflowRuleView } from '@/server/services/workflow/view'
import { createDoaOrg, type DoaOrg } from '../support/doa-org'

// S6-06 (FR-WF-103 AC1 AC2): what the workflow screens read, against Postgres — the list of versions with their
// status, the draft each code copies and the drafts not sent yet; one version in the editor's shape beside the version
// in effect with the rule-by-rule diff, the lint of BR-WF-11 as the submit runs it, what the condition builder and the
// reviewer pickers offer, and whether the draft can be sent now (the dry-run ran after the last save). Read only, for
// ORG_ADMIN (admin.workflow.draft): anyone else is refused in the service. The organization is the S6 fixture.

const NOW = new Date('2026-10-06T03:00:00Z')
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
const admin = () => org.ctxOf('admin', NOW)
const row = (id: string) => prisma.workflowVersion.findUniqueOrThrow({ where: { id } })

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createDoaOrg({ fixtures: { org: 'fixtures/org-s6.yaml', versions: 'fixtures/doa-versions.yaml' } })
  await prisma.roleAssignment.create({ data: { organizationId: org.organizationId, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
  // Version 1 in effect since 1 October: safety goods go to the DM of QSE
  const version = await prisma.workflowVersion.create({
    data: { organizationId: org.organizationId, code: 'WF-V', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-09-30T17:00:00Z'), publishedAt: NOW, changeReason: 'ฉบับตั้งต้น' },
  })
  await prisma.workflowRule.create({
    data: {
      organizationId: org.organizationId,
      workflowVersionId: version.id,
      code: 'RV-1',
      requestTypeCodes: ['BUY_GOODS'],
      when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY'] },
      reviewers: [POS('DM', 'QSE')],
      fallback: POS('VP', 'OPS'),
      mode: 'ALL',
      slaBusinessMinutes: 480,
      descriptionTh: 'ของความปลอดภัยผ่านฝ่ายความปลอดภัย',
      sortOrder: 0,
    },
  })
  v1 = version.id
})

describe('[FR-WF-103/AC1] the list of workflow versions', () => {
  it('shows each version with its status and rules, what a draft copies and the drafts not sent yet; others are refused', async () => {
    const before = ok(await listWorkflowVersions(admin()))
    expect(before.versions).toEqual([expect.objectContaining({ id: v1, code: 'WF-V', versionNo: 1, status: 'PUBLISHED', inEffect: true, upcoming: false, rules: 1, changeReason: 'ฉบับตั้งต้น' })])
    expect(before.sources.map((s) => s.id)).toEqual([v1])
    expect(before.openDrafts).toEqual([])

    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    const after = ok(await listWorkflowVersions(admin()))
    expect(after.openDrafts).toEqual([expect.objectContaining({ id: versionId, versionNo: 2, status: 'DRAFT', rules: 1, dryRunAt: null })])
    // A draft is never what the next draft copies
    expect(after.sources.map((s) => s.id)).toEqual([v1])

    // Read only for ORG_ADMIN: a requester and the CEO are refused in the service, not by a hidden link
    for (const who of ['req_con', 'ceo']) {
      expect(await listWorkflowVersions(org.ctxOf(who, NOW))).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await getWorkflowEditor(org.ctxOf(who, NOW), versionId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await getWorkflowEditor(org.ctxOf(who, NOW), 'not-an-id')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await getWorkflowEditor(admin(), 'not-an-id')).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await getWorkflowEditor(admin(), randomUUID())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('opens a draft in the editor shape beside the version in effect, with what the pickers offer', async () => {
    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    const view = ok(await getWorkflowEditor(admin(), versionId))
    expect(view.editable).toBe(true)
    expect(view.version).toMatchObject({ id: versionId, code: 'WF-V', status: 'DRAFT', lock: 0 })
    expect(view.rules).toEqual([
      {
        code: 'RV-1',
        requestTypeCodes: ['BUY_GOODS'],
        when: { field: '$lineCategories', op: 'anyIn', value: ['SAFETY'] },
        reviewers: [POS('DM', 'QSE')],
        fallback: POS('VP', 'OPS'),
        mode: 'ALL',
        quorumCount: null,
        slaMinutes: 480,
        descriptionTh: 'ของความปลอดภัยผ่านฝ่ายความปลอดภัย',
      },
    ])
    expect(view.baseline).toMatchObject({ id: v1, versionNo: 1, relation: 'IN_EFFECT' })
    expect(view.diff).toEqual({ added: [], removed: [], changed: [] })
    // The copy's date has passed: the editor offers the first of next month, never earlier than tomorrow
    expect([view.effectiveDate, view.minEffectiveDate]).toEqual(['2026-11-01', '2026-10-07'])
    // The condition builder: request types with the fields of their current form; the pickers: positions and departments
    expect(view.requestTypes.map((t) => t.code)).toEqual(expect.arrayContaining(['BUY_GOODS', 'HIRE_SERVICE', 'IT_PURCHASE']))
    const hire = view.requestTypes.find((t) => t.code === 'HIRE_SERVICE')!
    expect(hire.fields.find((f) => f.id === 'processesPersonalData')).toMatchObject({ type: 'select', options: [expect.objectContaining({ value: 'Y' }), expect.objectContaining({ value: 'N' })] })
    expect(view.positions.map((p) => p.code)).toEqual(expect.arrayContaining(['DM', 'VP', 'CEO']))
    expect(view.departments.find((d) => d.code === 'HQ')).toMatchObject({ depth: 0 })
    expect(view.departments.find((d) => d.code === 'QSE')).toMatchObject({ depth: 2 })
    expect(view.categoryCodes).toContain('SAFETY')
    expect(view.canSimulate).toBe(true)
    expect(view.dryRunDefaults).toEqual({ requesterMemberId: org.member.admin, chargedDepartmentId: org.department.IT })
    expect(view.route).toBeNull()
  })

  it('says rule by rule what the saved draft adds, removes and changes; a published version is read only', async () => {
    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    ok(
      await updateWorkflowVersion(
        admin(),
        {
          versionId,
          version: (await row(versionId)).version,
          effectiveDate: '2026-11-01',
          changeReason: 'เพิ่มผู้ตรวจของน้ำมัน',
          rules: [rule('RV-2', { when: { field: '$lineCategories', op: 'anyIn', value: ['FUEL'] }, reviewers: [POS('DM', 'PROC')] }), rule('RV-1', { slaMinutes: 960, descriptionTh: 'ของความปลอดภัยผ่านฝ่ายความปลอดภัย' })],
        },
        key(),
      ),
    )
    const view = ok(await getWorkflowEditor(admin(), versionId))
    expect(view.rules.map((r) => r.code)).toEqual(['RV-2', 'RV-1'])
    // The order of the rules is not a change; the time under the SLA is
    expect(view.diff).toEqual({ added: ['RV-2'], removed: [], changed: [{ code: 'RV-1', fields: ['sla'] }] })
    expect(view.effectiveDate).toBe('2026-11-01')

    const published = ok(await getWorkflowEditor(admin(), v1))
    expect(published).toMatchObject({ editable: false, submit: null, baseline: null, diff: null })
  })

  it('a removed rule and a changed condition, reviewer and mode are named in the diff', () => {
    const base: WorkflowRuleView = { code: 'RV-1', requestTypeCodes: ['BUY_GOODS'], when: {}, reviewers: [POS('DM', 'QSE')], fallback: null, mode: 'ALL', quorumCount: null, slaMinutes: 480, descriptionTh: null }
    const changed: WorkflowRuleView = { ...base, when: { field: '$amountGross', op: 'gt', value: '500000.00' }, reviewers: [POS('DM', 'QSE'), POS('DM', 'FIN')], mode: 'COUNT', quorumCount: 1 }
    expect(diffWorkflowRules([base, { ...base, code: 'RV-9' }], [changed])).toEqual({ added: [], removed: ['RV-9'], changed: [{ code: 'RV-1', fields: ['when', 'reviewers', 'mode'] }] })
  })
})

describe('[FR-WF-103/AC2] the lint and whether the draft can be sent', () => {
  it('shows the lint as the submit runs it, the failing test cases, the approver, and the send only after the dry-run', async () => {
    const { versionId } = ok(await draftWorkflowVersion(admin(), { sourceVersionId: v1 }, key()))
    const testCases = [{ name: 'น้ำมันต้องไปฝ่ายจัดซื้อ', input: { requestType: 'BUY_GOODS', amountGross: '5000.00', lineCategories: ['FUEL'], budgetAccountCodes: [], fields: {} }, expected: { ruleCodes: ['RV-2'] } }]
    ok(
      await updateWorkflowVersion(
        admin(),
        { versionId, version: (await row(versionId)).version, effectiveDate: '2026-11-01', changeReason: 'ลองข้อที่ไม่มีผู้สำรอง', rules: [rule('RV-1', { fallback: null }), rule('RV-9', { requestTypeCodes: ['NO_SUCH_TYPE'] })], testCases },
        key(),
      ),
    )
    const view = ok(await getWorkflowEditor(admin(), versionId))
    expect(view.lint.errors).toEqual([{ code: 'WF_LINT_UNKNOWN_REQUEST_TYPE', rule: 'RV-9', requestType: 'NO_SUCH_TYPE' }])
    expect(view.lint.warnings).toEqual([{ code: 'WF_LINT_NO_FALLBACK', rule: 'RV-1', key: 'WF_LINT_NO_FALLBACK:RV-1' }])
    expect(view.testCases).toEqual([{ name: 'น้ำมันต้องไปฝ่ายจัดซื้อ', input: { requestType: 'BUY_GOODS', amountGross: '5000.00', lineCategories: ['FUEL'], budgetAccountCodes: [], fields: {} }, expected: { ruleCodes: ['RV-2'] } }])
    expect(view.submit).toMatchObject({
      allowed: true,
      dryRunDone: false,
      effectiveInPast: false,
      laterVersionScheduled: null,
      testCasesFailing: ['น้ำมันต้องไปฝ่ายจัดซื้อ'],
      approver: { doaCode: expect.any(String), ruleCode: expect.any(String), approvers: [expect.objectContaining({ id: org.member.ceo })] },
    })

    // Fixed and saved, then dry-run: the send is open now (the service agrees)
    ok(
      await updateWorkflowVersion(
        admin(),
        {
          versionId,
          version: (await row(versionId)).version,
          effectiveDate: '2026-11-01',
          changeReason: 'เพิ่มผู้ตรวจของน้ำมัน',
          rules: [rule('RV-1', { fallback: null }), rule('RV-2', { when: { field: '$lineCategories', op: 'anyIn', value: ['FUEL'] }, reviewers: [POS('DM', 'PROC')] })],
          testCases,
        },
        key(),
      ),
    )
    const saved = ok(await getWorkflowEditor(admin(), versionId))
    expect(saved.lint.errors).toEqual([])
    expect(saved.submit).toMatchObject({ dryRunDone: false, testCasesFailing: [] })
    ok(await dryRunWorkflowVersion(admin(), { versionId, documents: [{ requestType: 'BUY_GOODS', amountGross: '5000.00', lineCategories: ['FUEL'], requesterMemberId: org.member.req_con!, chargedDepartmentId: org.department.CON! }] }, key()))
    const ready = ok(await getWorkflowEditor(admin(), versionId))
    expect(ready.submit).toMatchObject({ dryRunDone: true })
    expect(ready.version.dryRunAt).toBe(NOW.toISOString())

    // Sent: read only, with where its approval stands
    ok(await submitWorkflowVersion(admin(), { versionId, acknowledgedWarnings: ['WF_LINT_NO_FALLBACK:RV-1'] }, key()))
    const pending = ok(await getWorkflowEditor(admin(), versionId))
    expect(pending).toMatchObject({ editable: false, submit: null, version: { status: 'PENDING_APPROVAL', submittedBy: { id: org.member.admin } } })
    expect(pending.route?.tasks).toEqual([expect.objectContaining({ status: 'OPEN', assignee: expect.objectContaining({ id: org.member.ceo }) })])
  })
})
