import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { resolveReviewStep } from '@/core/workflow'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { deliverNotification, TASK_CLOSED } from '@/server/notifications/deliver'
import { portalCtx } from '@/server/portal/session'
import { riskReviewTaskPage, riskReviewTaskReaders, riskReviewTasksOf } from '@/server/queries/risk-review'
import {
  answerRiskAssessment,
  decideRiskReview,
  openRiskAssessment,
  requestRiskEvidenceDownload,
  reresolveReviewTasks,
  riskReviewTask,
  riskReviewTasks,
  runReviewTaskTimer,
  submitRiskAssessment,
  uploadRiskEvidence,
} from '@/server/services/risk'
import { draftWorkflowVersion, dryRunWorkflowVersion, updateWorkflowVersion } from '@/server/services/workflow'
import { getWorkflowEditor } from '@/server/services/workflow/view'
import { loadWorkflowVersions } from '@/server/workflow/policy'
import { loadDelegations, loadOrgSnapshot } from '@/server/doa/policy'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S11-06 (FR-RSK-202 AC1 to AC5 · BR-RSK-07 BR-RSK-08 BR-RSK-19 · BR-SOD-16 · INV-RSK-04 INV-RSK-05): the reviewers of a
// supplier risk assessment against Postgres — the rules of RISK_ASSESSMENT scope of the workflow version in effect name a
// task per slot at the send, each reviewer reads only GENERAL and its own domains, passes or returns it, the round gives
// one outcome however the decisions meet, and the tasks follow the tree. The rules, tiers and questions are test data.

const NOW = new Date('2026-11-09T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PDF = (text = 'hello') => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`)
let org: DoaOrg
const as = (code: string, now = NOW) => org.ctxOf(code, now)
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

const yn = (no: number) => [
  { code: 'Y', labelTh: 'ใช่', labelEn: 'Yes', points: 0 },
  { code: 'N', labelTh: 'ไม่ใช่', labelEn: 'No', points: no },
]
const QUESTIONS = [
  { code: 'RQ-GEN-01', domain: 'GENERAL' as const, options: yn(25), sortOrder: 10 },
  { code: 'RQ-PRV-01', domain: 'PRIVACY' as const, options: yn(20), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 20 },
  { code: 'RQ-IS-01', domain: 'INFOSEC' as const, options: yn(12), appliesWhen: { field: 'accessesSystems', op: 'eq', value: 'Y' }, sortOrder: 30 },
  { code: 'RQ-PRM-01', domain: 'PREMISES' as const, options: yn(10), appliesWhen: { field: 'accessesPremises', op: 'eq', value: 'Y' }, sortOrder: 40 },
  { code: 'RQ-FIN-01', domain: 'FINANCE' as const, options: yn(10), sortOrder: 50 },
]
const ALL_Y = (codes: readonly string[]) => codes.map((questionCode) => ({ questionCode, optionCode: 'Y' }))
const position = (p: string, d: string) => ({ kind: 'POSITION_AT', position: p, department: d })
// the reviewers of WF-T version 1: RR-01 to RR-04 as the SIMEC defaults (OQ-223) on the departments of org-p1
const RULES = [
  { code: 'RR-01', riskDomains: ['PRIVACY'], when: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, reviewers: [position('DM', 'PROC')], fallback: position('VP', 'SUP') },
  { code: 'RR-02', riskDomains: ['INFOSEC'], when: { field: 'accessesSystems', op: 'eq', value: 'Y' }, reviewers: [position('DM', 'IT')], fallback: position('VP', 'SUP') },
  { code: 'RR-03', riskDomains: ['PREMISES'], when: { field: 'accessesPremises', op: 'eq', value: 'Y' }, reviewers: [position('DM', 'CON')], fallback: position('VP', 'OPS') },
  { code: 'RR-04', riskDomains: ['FINANCE'], when: { field: '$tier', op: 'eq', value: 'HIGH' }, reviewers: [position('DM', 'FIN')], fallback: position('CFO', 'HQ') },
]

async function riskOrg(o: DoaOrg, rules: ReadonlyArray<(typeof RULES)[number]> = RULES) {
  const id = o.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: id, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: id, memberId: o.member.auditor!, role: 'AUDITOR', grantedAt: NOW },
      // dm_proc is also PROCUREMENT: a reviewer who could fill in for a supplier
      { organizationId: id, memberId: o.member.dm_proc!, role: 'PROCUREMENT', grantedAt: NOW },
    ],
  })
  for (const t of [
    { code: 'LOW' as const, minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'MEDIUM' as const, minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'HIGH' as const, minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
  ]) {
    await prisma.riskTier.create({ data: { organizationId: id, ...t, nameTh: t.code, nameEn: t.code, reminderDaysBefore: 30, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: NOW } })
  }
  await prisma.riskPolicy.create({
    data: { organizationId: id, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: NOW },
  })
  const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-11-01T00:00:00+07:00'), submittedById: o.member.admin!, submittedAt: NOW, publishedById: o.member.admin2!, publishedAt: NOW, checksum: 'test' } })
  for (const question of QUESTIONS) await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, textTh: `ข้อ ${question.code}`, textEn: `Question ${question.code}`, ...question } })
  const wf = await prisma.workflowVersion.create({ data: { organizationId: id, code: 'WF-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-10-01T00:00:00+07:00'), publishedAt: NOW } })
  for (const [i, r] of rules.entries()) {
    await prisma.workflowRule.create({ data: { organizationId: id, workflowVersionId: wf.id, code: r.code, requestTypeCodes: [], when: r.when, reviewers: r.reviewers, ...(r.fallback ? { fallback: r.fallback } : {}), mode: 'ALL', slaBusinessMinutes: 960, sortOrder: i + 1, scope: 'RISK_ASSESSMENT', riskDomains: r.riskDomains } })
  }
  return wf.id
}

let seq = 0
async function supplierWithContact(o: DoaOrg, payeeType: 'JURISTIC' | 'INDIVIDUAL' = 'JURISTIC') {
  const code = `RV-${++seq}-${randomUUID().slice(0, 4)}`
  const supplier = await prisma.supplier.create({ data: { organizationId: o.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true, portalEnabled: true, payeeType, email: `${code.toLowerCase()}@supplier.test` } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: o.organizationId, supplierId: supplier.id, nameTh: `ผู้ติดต่อ ${code}`, email: `c-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  return { supplierId: supplier.id, portal: (now = NOW) => portalCtx(o.organizationId, contact, now) }
}

const version = async (id: string) => (await prisma.riskAssessment.findUniqueOrThrow({ where: { id } })).version
type Screen = { processesPersonalData: 'Y' | 'N'; accessesSystems: 'Y' | 'N'; accessesPremises: 'Y' | 'N' }

/** An assessment opened by `opener`, answered Y in the portal (and its files, if any), and sent by the supplier */
async function sent(screening: Screen, options: { opener?: string; o?: DoaOrg; files?: readonly string[] } = {}) {
  const o = options.o ?? org
  const s = await supplierWithContact(o)
  const a = ok(await openRiskAssessment(o.ctxOf(options.opener ?? 'proc_officer', NOW), { supplierId: s.supplierId, screening }, key()))
  const codes = QUESTIONS.filter((q) => !q.appliesWhen || screening[q.appliesWhen.field as keyof Screen] === 'Y').map((q) => q.code)
  ok(await answerRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: ALL_Y(codes) }, key()))
  const files: Record<string, string> = {}
  for (const q of options.files ?? []) {
    const f = ok(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: q, fileName: `${q}.pdf`, bytes: PDF(q) }, key()))
    await prisma.fileObject.update({ where: { id: f.fileId }, data: { scanStatus: 'CLEAN' } })
    files[q] = f.fileId
  }
  const result = await submitRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId) }, key())
  return { ...a, ...s, result, codes, files }
}

const tasksOf = (assessmentId: string) => prisma.reviewTask.findMany({ where: { assessmentId }, orderBy: [{ reviewRound: 'asc' }, { slotNo: 'asc' }] })
const taskOf = async (assessmentId: string, ruleCode: string) => (await tasksOf(assessmentId)).find((t) => t.ruleCodes.includes(ruleCode) && t.status !== 'CANCELLED')!
const decide = (who: string, taskId: string, decision: 'PASS' | 'RETURN', extra: { reason?: string; shareWithSupplier?: boolean } = {}, now = NOW) => decideRiskReview(as(who, now), { taskId, decision, ...extra }, key())

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await riskOrg(org)
})

describe('[FR-RSK-202/AC1] the reviewers come from the screening of the work', () => {
  it('personal data and systems, tier HIGH → one task per matching rule at once, each told with no answer', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' })
    expect(ok(a.result)).toMatchObject({ status: 'IN_REVIEW', tier: 'HIGH' })
    const tasks = await tasksOf(a.assessmentId)
    expect(tasks.map((t) => [t.ruleCodes, t.assigneeMemberId, t.riskDomains, t.fallbackUsed, t.reviewRound])).toEqual([
      [['RR-01'], org.member.dm_proc, ['PRIVACY'], 'NONE', 1],
      [['RR-02'], org.member.dm_it, ['INFOSEC'], 'NONE', 1],
      [['RR-04'], org.member.dm_fin, ['FINANCE'], 'NONE', 1],
    ])
    expect(tasks.every((t) => t.dueAt > NOW && t.remindAt! > NOW && t.remindAt! < t.dueAt && t.escalateAt! > t.dueAt)).toBe(true)
    const row = await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })
    expect(row).toMatchObject({ status: 'IN_REVIEW', reviewRound: 1, workflowVersionId: tasks[0]!.workflowVersionId })
    const notices = await prisma.notification.findMany({ where: { templateKey: 'risk.review_assigned', subjectId: a.assessmentId } })
    expect(notices.map((n) => n.recipientMemberId).sort()).toEqual([org.member.dm_proc, org.member.dm_it, org.member.dm_fin].sort())
    // the tier, the domains and how many questions the reviewer reads; never an answer (BR-NOTI-01)
    const toIt = notices.find((n) => n.recipientMemberId === org.member.dm_it)!
    expect(toIt.data).toMatchObject({ tier: 'HIGH', riskDomains: ['INFOSEC'], questionCount: 2 })
    expect(JSON.stringify(toIt.data)).not.toMatch(/optionCode|"Y"/)
    expect(await prisma.event.count({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.reviewers_assigned' } })).toBe(1)
  })

  it('no rule matches (LOW, no screening Y) → COMPLETED at the send with no reviewer', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'N', accessesPremises: 'N' })
    expect(ok(a.result)).toMatchObject({ status: 'COMPLETED', tier: 'LOW' })
    expect(await tasksOf(a.assessmentId)).toHaveLength(0)
  })

  it('the opener is passed over for the fallback (CONFLICT · GC-RSK-28 · BR-SOD-16)', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' }, { opener: 'dm_proc' })
    expect(await taskOf(a.assessmentId, 'RR-01')).toMatchObject({ assigneeMemberId: org.member.vp_sup, fallbackUsed: 'CONFLICT' })
  })

  it('nobody holds the reviewer or its fallback → REVIEWER_NOT_FOUND, nothing sent, ORG_ADMIN and DOA_ADMIN told once', async () => {
    const gap = await createP2Org()
    await riskOrg(gap, [{ code: 'RR-09', riskDomains: ['INFOSEC'], when: { field: 'accessesSystems', op: 'eq', value: 'Y' }, reviewers: [position('DM', 'OPS')], fallback: null as never }])
    await prisma.roleAssignment.create({ data: { organizationId: gap.organizationId, memberId: gap.member.admin2!, role: 'DOA_ADMIN', grantedAt: NOW } })
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' }, { o: gap })
    expect(a.result).toMatchObject({ ok: false, error: { code: 'REVIEWER_NOT_FOUND', details: { rule: 'RR-09' } } })
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'DRAFT', reviewRound: 0 })
    const told = await prisma.notification.findMany({ where: { organizationId: gap.organizationId, templateKey: 'risk.reviewer_gap' } })
    expect(told.map((n) => n.recipientMemberId)).toEqual(expect.arrayContaining([gap.member.admin, gap.member.admin2]))
    expect(a.result).toMatchObject({ error: { details: { adminsNotified: told.length } } })
    expect(await prisma.event.count({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.reviewer_gap_reported' } })).toBe(1)
  })
})

describe('[FR-RSK-202/AC2] a reviewer is a slot of the workflow, never a role', () => {
  it('ORG_ADMIN AUDITOR and PROCUREMENT who hold no slot may not decide (deny); the holder may', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const t = await taskOf(a.assessmentId, 'RR-02')
    for (const who of ['admin', 'auditor', 'proc_officer', 'dm_fin']) expect(await decide(who, t.id, 'PASS')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await decide('dm_it', t.id, 'PASS'))).toMatchObject({ assessment: 'COMPLETED' })
  })

  it('RISK rules are drafted, tried with a screening and linted with admin.workflow.* (FR-WF-103 · WF_LINT_RISK_*)', async () => {
    const wf = await prisma.workflowVersion.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'WF-T', versionNo: 1 } })
    const draft = ok(await draftWorkflowVersion(as('admin'), { sourceVersionId: wf.id }, key()))
    // the copy keeps the scope and the domains of every rule
    const copied = await prisma.workflowRule.findMany({ where: { workflowVersionId: draft.versionId }, orderBy: { sortOrder: 'asc' } })
    expect(copied.map((r) => [r.code, r.scope, r.riskDomains, r.requestTypeCodes])).toEqual(RULES.map((r) => [r.code, 'RISK_ASSESSMENT', r.riskDomains, []]))
    const rule = (over: Record<string, unknown>) => ({ code: 'RR-02', scope: 'RISK_ASSESSMENT', requestTypeCodes: [], riskDomains: ['INFOSEC'], when: { field: 'accessesSystems', op: 'eq', value: 'Y' }, reviewers: [position('DM', 'FIN')], fallback: position('CFO', 'HQ'), mode: 'ALL', quorumCount: null, slaMinutes: 480, ...over })
    const save = async (rules: unknown[]) => updateWorkflowVersion(as('admin'), { versionId: draft.versionId, version: (await prisma.workflowVersion.findUniqueOrThrow({ where: { id: draft.versionId } })).version, effectiveDate: '2026-12-01', changeReason: 'ผู้ตรวจระบบเปลี่ยนเป็นฝ่ายการเงิน', rules: rules as never, testCases: [] }, key())
    // a RISK rule names no request type, a REQUEST rule no domain
    expect(await save([rule({ requestTypeCodes: ['BUY_GOODS'] })])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(await save([rule({ scope: 'REQUEST', requestTypeCodes: ['BUY_GOODS'] })])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    // and names the parts its reviewer sees (the CHECK of S11-01 · BR-RSK-08)
    expect(await save([rule({ riskDomains: [] })])).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    ok(await save([rule({}), rule({ code: 'RR-05', riskDomains: ['GENERAL'], when: { field: 'category', op: 'eq', value: 'IT' } })]))
    const editor = ok(await getWorkflowEditor(as('admin'), draft.versionId))
    expect(editor.rules.map((r) => [r.code, r.scope, r.riskDomains])).toEqual([
      ['RR-02', 'RISK_ASSESSMENT', ['INFOSEC']],
      ['RR-05', 'RISK_ASSESSMENT', ['GENERAL']],
    ])
    // a field the screening does not have stops the send (WF_LINT_RISK_FIELD)
    expect(editor.lint.errors.map((e) => [e.code, e.rule])).toEqual([['WF_LINT_RISK_FIELD', 'RR-05']])
    // the dry-run: the version in effect beside the draft for an assessment that touches the systems
    const tried = ok(await dryRunWorkflowVersion(as('admin'), { versionId: draft.versionId, documents: [], riskCases: [{ screening: { processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' }, tier: 'MEDIUM', categoryCodes: [], payeeType: 'JURISTIC', openedById: org.member.proc_officer! }] }, key()))
    expect(tried.riskRows).toEqual([
      {
        current: { ok: true, slots: [{ ruleCodes: ['RR-02'], memberIds: [org.member.dm_it], riskDomains: ['INFOSEC'] }], error: null },
        draft: { ok: true, slots: [{ ruleCodes: ['RR-02'], memberIds: [org.member.dm_fin], riskDomains: ['INFOSEC'] }], error: null },
        changed: true,
      },
    ])
    // a member without admin.workflow.simulate may not try it (deny)
    expect(await dryRunWorkflowVersion(as('dm_it'), { versionId: draft.versionId, documents: [], riskCases: [] }, key())).toMatchObject({ ok: false })
  })

  it('RISK off → MODULE_DISABLED before anything is read', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const t = await taskOf(a.assessmentId, 'RR-02')
    await prisma.orgModule.updateMany({ where: { organizationId: org.organizationId, module: 'RISK' }, data: { enabled: false } })
    try {
      expect(await decide('dm_it', t.id, 'PASS')).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    } finally {
      await prisma.orgModule.updateMany({ where: { organizationId: org.organizationId, module: 'RISK' }, data: { enabled: true } })
    }
  })
})

describe('[FR-RSK-202/AC3] every slot at once; all pass → COMPLETED, one return → RETURNED', () => {
  it('all passed: COMPLETED with its dates, the supplier current, each decision naming the version, rules and slot (INV-RSK-04)', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' })
    const [prv, is, fin] = [await taskOf(a.assessmentId, 'RR-01'), await taskOf(a.assessmentId, 'RR-02'), await taskOf(a.assessmentId, 'RR-04')]
    expect(ok(await decide('dm_proc', prv.id, 'PASS')).assessment).toBe('IN_REVIEW')
    expect(ok(await decide('dm_it', is.id, 'PASS')).assessment).toBe('IN_REVIEW')
    expect(ok(await decide('dm_fin', fin.id, 'PASS')).assessment).toBe('COMPLETED')
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'COMPLETED', tier: 'HIGH' })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: a.supplierId } })).toMatchObject({ riskTier: 'HIGH', riskStatus: 'CURRENT', currentRiskAssessmentId: a.assessmentId })
    // INV-RSK-04: the event of every decision names the slot it answers for, and its decider is the holder the engine names
    const decided = await prisma.event.findMany({ where: { type: 'review_task.decided', aggregateId: { in: [prv.id, is.id, fin.id] } } })
    expect(decided).toHaveLength(3)
    const step = await forTenant(org.organizationId).$transaction(async (tx) =>
      resolveReviewStep(
        (await loadWorkflowVersions(tx)).map((v) => ({ ...v, rules: v.rules.filter((r) => r.scope === 'RISK_ASSESSMENT').map((r) => ({ ...r, requestTypeCodes: ['RISK_ASSESSMENT'] })) })),
        { requestType: 'RISK_ASSESSMENT', amountGross: 0n, amountNet: 0n, basisAmountSatang: null, lineCategories: [], budgetAccountCodes: [], fields: { processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N', $tier: 'HIGH' }, requesterMemberId: org.member.proc_officer!, conflictMemberIds: [org.member.proc_officer!], at: NOW },
        await loadOrgSnapshot(tx),
        await loadDelegations(tx),
      ),
    )
    const slots = ok(step)!.slots
    for (const e of decided) {
      const d = e.data as { workflowVersionId: string; ruleCodes: string[]; slotNo: number; decidedById: string; decision: string }
      expect(d.workflowVersionId).toBe(prv.workflowVersionId)
      const slot = slots.find((s) => s.slotNo === d.slotNo)!
      expect(slot.ruleCodes).toEqual(d.ruleCodes)
      expect(slot.assignees.map((x) => x.assigneeMemberId)).toContain(d.decidedById)
      expect(d.decision).toBe('PASS')
    }
    expect(await prisma.notification.count({ where: { templateKey: 'risk.assessment_completed', subjectId: a.assessmentId, recipientMemberId: org.member.proc_officer } })).toBe(1)
    expect(await prisma.supplierNotice.count({ where: { subjectId: a.assessmentId, templateKey: 'supplier.risk_completed' } })).toBe(1)
    // a decided task is decided once; the second answer names who decided it
    expect(await decide('dm_it', is.id, 'PASS')).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION', details: { from: 'PASSED' } } })
  })

  it('one return: RETURNED, the other open tasks CANCELLED (STEP_DECIDED), only the words allowed reach the supplier', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' })
    const [prv, is, fin] = [await taskOf(a.assessmentId, 'RR-01'), await taskOf(a.assessmentId, 'RR-02'), await taskOf(a.assessmentId, 'RR-04')]
    ok(await decide('dm_proc', prv.id, 'PASS'))
    expect(await decide('dm_it', is.id, 'RETURN')).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(ok(await decide('dm_it', is.id, 'RETURN', { reason: 'แนบนโยบายความปลอดภัยฉบับลงนาม', shareWithSupplier: true })).assessment).toBe('RETURNED')
    expect((await prisma.reviewTask.findUniqueOrThrow({ where: { id: fin.id } })).status).toBe('CANCELLED')
    expect(await prisma.reviewTask.findUniqueOrThrow({ where: { id: fin.id } })).toMatchObject({ cancelledWhy: 'STEP_DECIDED' })
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'RETURNED', returnReason: 'แนบนโยบายความปลอดภัยฉบับลงนาม' })
    const mail = await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: a.assessmentId, templateKey: 'supplier.risk_returned' } })
    expect(mail.data).toMatchObject({ reason: 'แนบนโยบายความปลอดภัยฉบับลงนาม' })
    expect(await decide('dm_fin', fin.id, 'PASS')).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    // no "reject" exists (BR-WF-09)
    expect(await decideRiskReview(as('dm_fin'), { taskId: fin.id, decision: 'REJECT' as never }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    // the supplier answers again and sends: a new round, found again under the version in effect
    ok(await submitRiskAssessment(a.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId) }, key()))
    const round2 = (await tasksOf(a.assessmentId)).filter((t) => t.reviewRound === 2)
    expect(round2.map((t) => t.ruleCodes[0])).toEqual(['RR-01', 'RR-02', 'RR-04'])
  })

  it('a reason kept from the supplier stays out of the assessment and the e-mail', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const is = await taskOf(a.assessmentId, 'RR-02')
    ok(await decide('dm_it', is.id, 'RETURN', { reason: 'ภายใน: ผู้ขายรายนี้เคยมีเหตุข้อมูลรั่ว' }))
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'RETURNED', returnReason: null })
    const mail = await prisma.supplierNotice.findFirstOrThrow({ where: { subjectId: a.assessmentId, templateKey: 'supplier.risk_returned' } })
    expect(JSON.stringify(mail.data)).not.toContain('ภายใน')
    expect(await prisma.comment.findFirst({ where: { subjectType: 'RiskAssessment', subjectId: a.assessmentId } })).toMatchObject({ body: 'ภายใน: ผู้ขายรายนี้เคยมีเหตุข้อมูลรั่ว', authorMemberId: org.member.dm_it })
  })

  it('[BR-NOTI-12] a notice of a task decided before it went out stays in the bell (TASK_CLOSED)', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' })
    const [prv, is] = [await taskOf(a.assessmentId, 'RR-01'), await taskOf(a.assessmentId, 'RR-02')]
    ok(await decide('dm_it', is.id, 'RETURN', { reason: 'ขาดเอกสาร' }))
    for (const t of [is, prv]) {
      const notice = await prisma.notification.findFirstOrThrow({ where: { templateKey: 'risk.review_assigned', recipientMemberId: t.assigneeMemberId, subjectId: a.assessmentId } })
      expect(await deliverNotification(org.organizationId, notice.id, NOW)).toEqual({ status: 'SKIPPED', why: TASK_CLOSED })
    }
  })

  it('[BR-RSK-19] the last two slots decided at the same moment complete the assessment once', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'Y' })
    const [is, prm] = [await taskOf(a.assessmentId, 'RR-02'), await taskOf(a.assessmentId, 'RR-03')]
    const both = await Promise.all([decide('dm_it', is.id, 'PASS'), decide('dm_con', prm.id, 'PASS')])
    expect(both.every((r) => r.ok)).toBe(true)
    expect(both.map((r) => (r.ok ? r.data.assessment : null)).sort()).toEqual(['COMPLETED', 'IN_REVIEW'])
    expect(await prisma.event.count({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.completed' } })).toBe(1)
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'COMPLETED' })
  })

  it('[BR-RSK-19] a pass and a return at the same moment give RETURNED, never both outcomes', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'Y' })
    const [is, prm] = [await taskOf(a.assessmentId, 'RR-02'), await taskOf(a.assessmentId, 'RR-03')]
    await Promise.all([decide('dm_it', is.id, 'PASS'), decide('dm_con', prm.id, 'RETURN', { reason: 'ขาดแผนผังพื้นที่' })])
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'RETURNED' })
    expect(await prisma.event.count({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.completed' } })).toBe(0)
  })
})

describe('[FR-RSK-202/AC4] each reviewer reads GENERAL and its own domains only', () => {
  it('the task page shows the slot’s questions, the other slots’ state without their answers or reasons, no step-up', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' })
    const [prv, is] = [await taskOf(a.assessmentId, 'RR-01'), await taskOf(a.assessmentId, 'RR-02')]
    const page = ok(await riskReviewTask(as('dm_it'), is.id))
    expect(page.questions.map((q) => q.code)).toEqual(['RQ-GEN-01', 'RQ-IS-01'])
    expect(page.questions.every((q) => q.answer?.optionCode === 'Y')).toBe(true)
    expect(page.slots.map((s) => [s.slotNo, s.riskDomains, s.status, s.mine])).toEqual([
      [1, ['PRIVACY'], 'OPEN', false],
      [2, ['INFOSEC'], 'OPEN', true],
      [3, ['FINANCE'], 'OPEN', false],
    ])
    expect(page.canDecide).toBe(true)
    // another member reads it as missing; the page of another slot is its holder's
    expect(await riskReviewTask(as('dm_fin'), is.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await riskReviewTask(as('proc_officer'), prv.id)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    const list = ok(await riskReviewTasks(as('dm_it'), 'OPEN'))
    expect(list.map((t) => t.taskId)).toContain(is.id)
    expect(list.map((t) => t.taskId)).not.toContain(prv.id)
  })

  it('[INV-RSK-05] every query of the reviewer, with the context of every slot, returns nothing outside its domains', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'Y' })
    const tasks = (await tasksOf(a.assessmentId)).filter((t) => t.status === 'OPEN')
    expect(tasks).toHaveLength(4)
    const holders: Record<string, string> = { 'RR-01': 'dm_proc', 'RR-02': 'dm_it', 'RR-03': 'dm_con', 'RR-04': 'dm_fin' }
    // one slot passes and another returns with a reason, so a decision and a reason exist for the others not to see
    ok(await decide('dm_fin', (await taskOf(a.assessmentId, 'RR-04')).id, 'PASS'))
    ok(await decide('dm_con', (await taskOf(a.assessmentId, 'RR-03')).id, 'RETURN', { reason: 'ขาดแผนผังพื้นที่' }))
    const domainOf = Object.fromEntries(QUESTIONS.map((q) => [q.code, q.domain]))
    const queries = { riskReviewTaskPage, riskReviewTaskReaders, riskReviewTasksOf }
    expect(Object.keys(queries).sort()).toEqual(
      Object.keys(await import('@/server/queries/risk-review'))
        .filter((k) => k.startsWith('riskReview'))
        .sort(),
    )
    for (const t of tasks) {
      const ctx = as(holders[t.ruleCodes[0]!]!)
      const seen = ['GENERAL', ...t.riskDomains]
      for (const other of tasks.filter((x) => x.id !== t.id)) {
        expect(await riskReviewTaskPage(ctx, other.id), `${t.ruleCodes[0]} reads ${other.ruleCodes[0]}`).toBeNull()
        expect(await riskReviewTaskReaders(ctx, other.id)).not.toContain(ctx.actor.type === 'USER' ? ctx.actor.memberId : '')
      }
      const page = (await riskReviewTaskPage(ctx, t.id))!
      expect(page.questions.length).toBeGreaterThan(0)
      for (const q of page.questions) expect(seen, `${t.ruleCodes[0]} sees ${q.code}`).toContain(domainOf[q.code])
      if (t.ruleCodes[0] !== 'RR-03') expect(JSON.stringify(page), `${t.ruleCodes[0]} reads the reason of RR-03`).not.toMatch(/ขาดแผนผัง/)
      for (const which of ['OPEN', 'DONE'] as const) {
        for (const row of await riskReviewTasksOf(ctx, which)) expect(tasks.find((x) => x.id === row.taskId)?.assigneeMemberId ?? t.assigneeMemberId).toBe(t.assigneeMemberId)
      }
    }
  })

  it('[BR-RSK-08] a reviewer opens the evidence of its own domains only (risk.evidence.view ASSIGNED)', async () => {
    const a = await sent({ processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' }, { files: ['RQ-IS-01', 'RQ-PRV-01', 'RQ-GEN-01'] })
    const open = (who: string, q: string) => requestRiskEvidenceDownload(as(who), { assessmentId: a.assessmentId, fileId: a.files[q]! }, key())
    expect(ok(await open('dm_it', 'RQ-IS-01')).url).toMatch(/^https?:\/\//)
    expect(ok(await open('dm_it', 'RQ-GEN-01')).url).toMatch(/^https?:\/\//)
    expect(await open('dm_it', 'RQ-PRV-01')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(ok(await open('dm_proc', 'RQ-PRV-01')).url).toMatch(/^https?:\/\//)
    expect(await open('dm_con', 'RQ-IS-01')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-RSK-202/AC5] separation of duties, acting holders, SLA and the tree', () => {
  it('[BR-SOD-16] who filled the assessment in is refused even when the task is theirs (SOD_VIOLATION, audited)', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const is = await taskOf(a.assessmentId, 'RR-02')
    // as if an org change had given the slot to the opener: the decision is refused all the same
    await prisma.reviewTask.update({ where: { id: is.id }, data: { assigneeMemberId: org.member.proc_officer! } })
    expect(await decide('proc_officer', is.id, 'PASS')).toMatchObject({ ok: false, error: { code: 'SOD_VIOLATION', details: { rule: 'BR-SOD-16' } } })
    expect(await prisma.event.findFirst({ where: { type: 'security.sod_blocked', aggregateId: a.assessmentId } })).toMatchObject({ data: { rule: 'BR-SOD-16' } })
    expect((await prisma.reviewTask.findUniqueOrThrow({ where: { id: is.id } })).status).toBe('OPEN')
  })

  it('an acting holder decides through a delegation of no document type and no amount; a limited one does not count', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const is = await taskOf(a.assessmentId, 'RR-02')
    const window = { startsAt: new Date('2026-11-08T00:00:00Z'), endsAt: new Date('2026-11-20T00:00:00Z'), status: 'ACTIVE' as const, reason: 'ลาพักร้อน', createdVia: 'SELF' as const }
    const limited = await prisma.delegation.create({ data: { organizationId: org.organizationId, delegatorMemberId: org.member.dm_it!, delegateMemberId: org.member.admin!, documentTypes: ['PURCHASE_REQUEST'], ...window } })
    expect(await decide('admin', is.id, 'PASS')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await prisma.delegation.update({ where: { id: limited.id }, data: { status: 'REVOKED', revokedAt: NOW } })
    const open = await prisma.delegation.create({ data: { organizationId: org.organizationId, delegatorMemberId: org.member.dm_it!, delegateMemberId: org.member.admin!, documentTypes: [], ...window } })
    try {
      expect(ok(await riskReviewTasks(as('admin'), 'OPEN')).map((t) => t.taskId)).toContain(is.id)
      expect(ok(await decide('admin', is.id, 'PASS'))).toMatchObject({ assessment: 'COMPLETED' })
      expect(await prisma.event.findFirst({ where: { type: 'review_task.decided', aggregateId: is.id } })).toMatchObject({ data: { decidedById: org.member.admin, onBehalfOf: org.member.dm_it } })
      // a task assigned while the delegation runs falls to the acting holder at once, for its holder (BR-DLG-04)
      const b = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
      expect(await taskOf(b.assessmentId, 'RR-02')).toMatchObject({ assigneeMemberId: org.member.admin, delegatorMemberId: org.member.dm_it })
      expect(ok(await riskReviewTask(as('dm_it'), (await taskOf(b.assessmentId, 'RR-02')).id)).canDecide).toBe(true)
    } finally {
      await prisma.delegation.update({ where: { id: open.id }, data: { status: 'REVOKED', revokedAt: NOW } })
    }
  })

  it('the timers: not before their time, the reviewer reminded and told it is overdue, the fallback told at escalateAt', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const is = await taskOf(a.assessmentId, 'RR-02')
    expect(await runReviewTaskTimer(org.organizationId, is.id, 'REMIND', NOW)).toMatchObject({ done: false, reason: 'NOT_DUE' })
    expect(await runReviewTaskTimer(org.organizationId, is.id, 'REMIND', is.remindAt!)).toMatchObject({ done: true })
    expect(await runReviewTaskTimer(org.organizationId, is.id, 'OVERDUE', is.dueAt)).toMatchObject({ done: true })
    expect(await runReviewTaskTimer(org.organizationId, is.id, 'ESCALATE', is.escalateAt!)).toMatchObject({ done: true })
    const told = await prisma.notification.findMany({ where: { subjectId: a.assessmentId, templateKey: { in: ['risk.review_reminder', 'risk.review_overdue', 'risk.review_escalated'] } } })
    expect(told.map((n) => [n.templateKey, n.recipientMemberId]).sort()).toEqual(
      [
        ['risk.review_escalated', org.member.vp_sup],
        ['risk.review_overdue', org.member.dm_it],
        ['risk.review_reminder', org.member.dm_it],
      ].sort(),
    )
    // a run of the same timer again replays its answer (the job's retry); a decided task has no timer left
    expect(await runReviewTaskTimer(org.organizationId, is.id, 'ESCALATE', is.escalateAt!)).toMatchObject({ done: true })
    const b = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const done = await taskOf(b.assessmentId, 'RR-02')
    ok(await decide('dm_it', done.id, 'PASS'))
    expect(await runReviewTaskTimer(org.organizationId, done.id, 'REMIND', done.remindAt!)).toMatchObject({ done: false, reason: 'CLOSED' })
    expect(await prisma.notification.count({ where: { subjectId: b.assessmentId, templateKey: 'risk.review_reminder' } })).toBe(0)
  })

  it('a new holder of the slot’s position gets the open task, in place, with its times (ADR-108)', async () => {
    const a = await sent({ processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' })
    const is = await taskOf(a.assessmentId, 'RR-02')
    const holder = await prisma.positionAssignment.findFirstOrThrow({ where: { organizationId: org.organizationId, memberId: org.member.dm_it!, validTo: null, position: { code: 'DM' } } })
    const at = new Date('2026-11-10T03:00:00Z')
    await prisma.positionAssignment.update({ where: { id: holder.id }, data: { validTo: at } })
    const newcomer = await prisma.positionAssignment.create({ data: { organizationId: org.organizationId, positionId: holder.positionId, departmentId: holder.departmentId, memberId: org.member.admin!, validFrom: at } })
    try {
      const out = { events: [] as never[], notifications: [] as never[] }
      const moved = await forTenant(org.organizationId).$transaction((tx) => reresolveReviewTasks(tx, as('admin', at), at, out))
      expect(moved.moved).toBeGreaterThanOrEqual(1)
      expect(await prisma.reviewTask.findUniqueOrThrow({ where: { id: is.id } })).toMatchObject({ status: 'OPEN', assigneeMemberId: org.member.admin, slotNo: is.slotNo, dueAt: is.dueAt })
      expect(out.events.some((e: { type: string; aggregateId: string }) => e.type === 'review_task.reassigned' && e.aggregateId === is.id)).toBe(true)
      expect(out.notifications.some((n: { recipientMemberId: string; templateKey: string }) => n.recipientMemberId === org.member.admin && n.templateKey === 'risk.review_assigned')).toBe(true)
    } finally {
      await prisma.positionAssignment.delete({ where: { id: newcomer.id } })
      await prisma.positionAssignment.update({ where: { id: holder.id }, data: { validTo: null } })
    }
  })
})
