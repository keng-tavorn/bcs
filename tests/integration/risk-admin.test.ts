import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { inherentTier, scoreAssessment, selectQuestions, type RiskContext, type RiskQuestionDef } from '@/core/risk'
import { makeCtx } from '@/server/context'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import {
  confirmRiskPolicy,
  confirmRiskTiers,
  discardRiskPolicy,
  discardRiskTiers,
  draftRiskQuestionnaire,
  previewRiskQuestionSet,
  proposeRiskPolicy,
  proposeRiskTiers,
  publishRiskQuestionnaire,
  questionnaireInEffect,
  rejectRiskQuestionnaire,
  removeRiskQuestion,
  reorderRiskQuestions,
  riskPolicyInEffect,
  riskQuestionnaireDetail,
  riskTiersAdminView,
  riskTiersInEffect,
  submitRiskQuestionnaire,
  supersedeDueQuestionnaires,
  updateRiskQuestion,
} from '@/server/services/risk'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S11-04 (BR-RSK-02 · ADR-229 · FR-RSK-201): the tiers, the gate policy and the questionnaire versions of an organization
// against Postgres, through the services the admin pages call — a proposal waits in pending* and changes no result until
// someone else confirms it; the one who proposed or sent never confirms or publishes; PROCUREMENT, PLATFORM_ADMIN and an
// ORG_ADMIN whose DOA administrators are separated are refused. The tiers here are the demo values of OQ-221 as test data.

const NOW = new Date('2026-11-08T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
let org: DoaOrg
const as = (code: string, now = NOW) => org.ctxOf(code, now)
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof forTenant>['$transaction']>[0]>[0]) => Promise<T>) => forTenant(org.organizationId).$transaction(fn)

const TIERS = [
  { code: 'LOW' as const, nameTh: 'ต่ำ', nameEn: 'Low', minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'MEDIUM' as const, nameTh: 'กลาง', nameEn: 'Medium', minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
  { code: 'HIGH' as const, nameTh: 'สูง', nameEn: 'High', minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
]
const QUESTIONS: RiskQuestionDef[] = [
  { code: 'RQ-GEN-01', domain: 'GENERAL', options: [{ code: 'Y', points: 0 }, { code: 'N', points: 25 }], sortOrder: 10 },
  { code: 'RQ-PRV-01', domain: 'PRIVACY', options: [{ code: 'Y', points: 0 }, { code: 'N', points: 20 }], appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 20 },
]
const CONTEXT: RiskContext = { screening: { processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' }, categoryCodes: ['IT'], payeeType: 'JURISTIC', isForeign: false }

const question = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  domain: 'GENERAL' as const,
  textTh: `คำถาม ${code}`,
  textEn: `Question ${code}`,
  options: [
    { code: 'Y', labelTh: 'ใช่', labelEn: 'Yes', points: 0 },
    { code: 'N', labelTh: 'ไม่ใช่', labelEn: 'No', points: 10 },
  ],
  ...over,
})

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  const id = org.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: id, memberId: org.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: id, memberId: org.member.admin2!, role: 'ORG_ADMIN', grantedAt: NOW },
      { organizationId: id, memberId: org.member.auditor!, role: 'DOA_ADMIN', grantedAt: NOW },
    ],
  })
  // the seed's rows: admin proposed, admin2 confirmed (ADR-229)
  for (const t of TIERS) await prisma.riskTier.create({ data: { organizationId: id, ...t, reminderDaysBefore: 30, updatedById: org.member.admin!, confirmedById: org.member.admin2!, confirmedAt: NOW } })
  await prisma.riskPolicy.create({
    data: { organizationId: id, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: org.member.admin!, confirmedById: org.member.admin2!, confirmedAt: NOW },
  })
  await prisma.supplierDocumentType.create({ data: { organizationId: id, code: 'ISO_CERT', nameTh: 'ใบรับรอง ISO', nameEn: 'ISO certificate', appliesTo: ['JURISTIC'], singleInstance: false, linkedRiskQuestionCodes: ['RQ-IS-01'] } })
})

const pendingRows = async () => (await prisma.riskTier.findMany({ where: { organizationId: org.organizationId, pendingById: { not: null } } })).map((r) => ({ code: r.code, version: r.version }))
const policyVersion = async () => (await prisma.riskPolicy.findFirstOrThrow({ where: { organizationId: org.organizationId } })).version

describe('[FR-RSK-201/AC4] [BR-RSK-02] a proposal changes no result until someone else confirms it', () => {
  it('a tier proposal leaves the tiers in effect, the score and the tier of an assessment as they were', async () => {
    const before = ok(await tx(riskTiersInEffect))
    const policy = ok(await tx(riskPolicyInEffect))
    const scoreBefore = scoreAssessment(QUESTIONS, before, policy, CONTEXT, { 'RQ-GEN-01': 'N' })
    expect(scoreBefore).toMatchObject({ points: 25, tier: 'MEDIUM' })
    ok(await proposeRiskTiers(as('admin'), { changes: { MEDIUM: { minPoints: 30 }, HIGH: { minPoints: 50, reviewMonths: 6 } } }, key()))
    const after = ok(await tx(riskTiersInEffect))
    expect(after).toEqual(before)
    expect(scoreAssessment(QUESTIONS, after, policy, CONTEXT, { 'RQ-GEN-01': 'N' })).toEqual(scoreBefore)
    const view = ok(await riskTiersAdminView(as('admin2')))
    expect(view.tiers.find((t) => t.code === 'MEDIUM')).toMatchObject({ inEffect: { minPoints: 20 }, pending: { minPoints: 30 }, pendingByMe: false })
    expect(await prisma.event.findFirst({ where: { organizationId: org.organizationId, type: 'risk_tier.proposed' } })).toMatchObject({ data: { code: 'MEDIUM', pendingChange: { minPoints: 30 } } })
  })

  it('the proposer confirming is refused SAME_EDITOR; another proposal waits; another administrator confirms in one transaction', async () => {
    const rows = await pendingRows()
    expect(rows.map((r) => r.code).sort()).toEqual(['HIGH', 'MEDIUM'])
    expect(await confirmRiskTiers(as('admin'), { rows }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SAME_EDITOR' } } })
    expect(await proposeRiskTiers(as('admin2'), { changes: { LOW: { reviewMonths: 48 } } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PENDING_CHANGE_EXISTS' } } })
    // a proposal read at another version is not confirmed unseen
    expect(await confirmRiskTiers(as('admin2'), { rows: rows.map((r) => ({ ...r, version: r.version + 1 })) }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    ok(await confirmRiskTiers(as('admin2'), { rows }, key()))
    const after = ok(await tx(riskTiersInEffect))
    expect(after.find((t) => t.code === 'MEDIUM')!.minPoints).toBe(30)
    expect(after.find((t) => t.code === 'HIGH')).toMatchObject({ minPoints: 50, reviewMonths: 6 })
    const policy = ok(await tx(riskPolicyInEffect))
    expect(scoreAssessment(QUESTIONS, after, policy, CONTEXT, { 'RQ-GEN-01': 'N' })).toMatchObject({ points: 25, tier: 'MEDIUM' })
    const high = await prisma.riskTier.findFirstOrThrow({ where: { organizationId: org.organizationId, code: 'HIGH' } })
    expect(high).toMatchObject({ updatedById: org.member.admin, confirmedById: org.member.admin2, pendingById: null, pendingChange: null })
    const confirmed = await prisma.event.findMany({ where: { organizationId: org.organizationId, type: 'risk_tier.confirmed' } })
    expect(confirmed.map((e) => (e.data as { code: string }).code).sort()).toEqual(['HIGH', 'MEDIUM'])
    expect(confirmed.find((e) => (e.data as { code: string }).code === 'HIGH')!.data).toMatchObject({ changed: expect.arrayContaining([{ field: 'minPoints', from: 40, to: 50 }]), proposedById: org.member.admin, confirmedById: org.member.admin2 })
  })

  it('TIER_ORDER is checked on the tiers as they would be; nothing equal to the values in effect is proposed; discard clears', async () => {
    expect(await proposeRiskTiers(as('admin'), { changes: { MEDIUM: { minPoints: 60 } } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TIER_ORDER', problem: 'NOT_RISING' } } })
    expect(await proposeRiskTiers(as('admin'), { changes: { LOW: { minPoints: 1 } } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TIER_ORDER', problem: 'LOW_NOT_ZERO' } } })
    expect(await proposeRiskTiers(as('admin'), { changes: { MEDIUM: { minPoints: 30 } } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NO_CHANGE' } } })
    expect(await proposeRiskTiers(as('admin'), { changes: { HIGH: { reviewMonths: 121 } } }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    ok(await proposeRiskTiers(as('admin'), { changes: { LOW: { reminderDaysBefore: 14 } } }, key()))
    // the proposer may discard their own proposal
    ok(await discardRiskTiers(as('admin'), { rows: await pendingRows() }, key()))
    expect(await pendingRows()).toEqual([])
    expect(await confirmRiskTiers(as('admin2'), { rows: [{ code: 'LOW', version: 0 }] }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
    expect(await prisma.event.count({ where: { organizationId: org.organizationId, type: 'risk_tier.discarded' } })).toBe(1)
  })

  it('a policy proposal leaves the policy in effect and the inherent tier as they were; another administrator confirms it', async () => {
    const before = ok(await tx(riskPolicyInEffect))
    expect(inherentTier(CONTEXT, before)).toBe('MEDIUM')
    ok(await proposeRiskPolicy(as('admin2'), { changes: { screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'HIGH', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF', 'IT'] } }, key()))
    expect(ok(await tx(riskPolicyInEffect))).toEqual(before)
    expect(inherentTier(CONTEXT, ok(await tx(riskPolicyInEffect)))).toBe('MEDIUM')
    expect(selectQuestions(QUESTIONS, CONTEXT, ok(await tx(riskPolicyInEffect))).inherentTier).toBe('MEDIUM')
    expect(await confirmRiskPolicy(as('admin2'), { version: await policyVersion() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SAME_EDITOR' } } })
    expect(await proposeRiskPolicy(as('admin'), { changes: { registryFlagBlocks: false } }, key())).toMatchObject({ ok: false, error: { details: { reason: 'PENDING_CHANGE_EXISTS' } } })
    ok(await confirmRiskPolicy(as('auditor'), { version: await policyVersion() }, key()))
    const after = ok(await tx(riskPolicyInEffect))
    expect(after.highRiskCategories).toEqual(['PROF', 'IT'])
    expect(inherentTier(CONTEXT, after)).toBe('HIGH')
    expect(await prisma.event.findFirst({ where: { organizationId: org.organizationId, type: 'risk_policy.confirmed' } })).toMatchObject({ data: { proposedById: org.member.admin2, confirmedById: org.member.auditor } })
    ok(await proposeRiskPolicy(as('admin'), { changes: { overrideChatButton: true } }, key()))
    ok(await discardRiskPolicy(as('admin2'), { version: await policyVersion() }, key()))
    expect(ok(await tx(riskPolicyInEffect)).overrideChatButton).toBe(false)
  })
})

describe('[BR-RSK-02] who may set the tiers and the questionnaire (deny)', () => {
  it('PROCUREMENT and PLATFORM_ADMIN are refused; nothing is written', async () => {
    const platformAdmin = await prisma.platformAdmin.create({ data: { displayName: 'ทีม BCS', active: true } })
    const platform = makeCtx({ organizationId: org.organizationId, actor: { type: 'PLATFORM_ADMIN', platformAdminId: platformAdmin.id }, channel: 'WEB', now: NOW })
    for (const ctx of [as('proc_officer'), platform]) {
      expect(await proposeRiskTiers(ctx, { changes: { LOW: { reviewMonths: 40 } } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await proposeRiskPolicy(ctx, { changes: { registryFlagBlocks: false } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await draftRiskQuestionnaire(ctx, { code: 'RQ-DENY' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
      expect(await riskTiersAdminView(ctx)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    }
    expect(await prisma.riskTier.count({ where: { organizationId: org.organizationId, pendingById: { not: null } } })).toBe(0)
    expect(await prisma.riskQuestionnaire.count({ where: { organizationId: org.organizationId, code: 'RQ-DENY' } })).toBe(0)
  })

  it('an ORG_ADMIN is refused once the DOA version in effect separates the DOA administrators; DOA_ADMIN keeps it', async () => {
    const other = await createP2Org()
    const id = other.organizationId
    await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
    await prisma.roleAssignment.createMany({ data: [{ organizationId: id, memberId: other.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW }, { organizationId: id, memberId: other.member.auditor!, role: 'DOA_ADMIN', grantedAt: NOW }] })
    for (const t of TIERS) await prisma.riskTier.create({ data: { organizationId: id, ...t, reminderDaysBefore: 30, updatedById: other.member.admin!, confirmedById: other.member.auditor!, confirmedAt: NOW } })
    const version = await prisma.doaVersion.findFirstOrThrow({ where: { organizationId: id, status: 'PUBLISHED' } })
    await prisma.doaVersion.update({ where: { id: version.id }, data: { sodPolicy: { ...(version.sodPolicy as object), doaAdminSeparated: true } } })
    const asOther = (code: string) => other.ctxOf(code, NOW)
    expect(await proposeRiskTiers(asOther('admin'), { changes: { LOW: { reviewMonths: 40 } } }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'DOA_ADMIN_SEPARATED' } } })
    expect(await draftRiskQuestionnaire(asOther('admin'), { code: 'RQ-SEP' }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', details: { reason: 'DOA_ADMIN_SEPARATED' } } })
    ok(await proposeRiskTiers(asOther('auditor'), { changes: { LOW: { reviewMonths: 40 } } }, key()))
  })

  it('every command of the step is refused MODULE_DISABLED while RISK is off', async () => {
    const off = await createP2Org()
    await prisma.roleAssignment.create({ data: { organizationId: off.organizationId, memberId: off.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW } })
    expect(await proposeRiskTiers(off.ctxOf('admin', NOW), { changes: { LOW: { reviewMonths: 40 } } }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await draftRiskQuestionnaire(off.ctxOf('admin', NOW), { code: 'RQ-OFF' }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
  })
})

describe('[FR-RSK-201/AC4] [BR-RSK-01] [BR-RSK-05] a questionnaire version: draft, lint, send, publish by someone else', () => {
  let firstId: string

  it('a draft is edited by question, refused a second draft, and sent only when the lint passes', async () => {
    firstId = ok(await draftRiskQuestionnaire(as('admin'), { code: 'RQ-TEST' }, key())).versionId
    expect(await draftRiskQuestionnaire(as('admin2'), { code: 'RQ-TEST' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'DRAFT_EXISTS' } } })
    const v = async () => (await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: firstId } })).version
    ok(await updateRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: await v(), question: question('RQ-GEN-01') }, key()))
    ok(await updateRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: await v(), question: question('RQ-PRV-01', { domain: 'PRIVACY', appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' } }) }, key()))
    // ISO_CERT keeps several copies, so the question it answers must name its scope (RISK_LINT_SCOPE_REQUIRED)
    ok(await updateRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: await v(), question: question('RQ-IS-01', { domain: 'INFOSEC' }) }, key()))
    expect(await updateRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: await v(), question: question('RQ-IS-02', { appliesWhen: { field: 'budget', op: 'gt', value: 1 } }) }, key())).toMatchObject({ ok: false, error: { details: { reason: 'CONDITION' } } })
    expect(await updateRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: (await v()) - 1, question: question('RQ-IS-02') }, key())).toMatchObject({ ok: false, error: { code: 'CONFLICT_VERSION' } })
    const effectiveFrom = new Date('2026-11-08T05:00:00Z').toISOString()
    const lintFail = await submitRiskQuestionnaire(as('admin'), { versionId: firstId, expectedVersion: await v(), effectiveFrom, changeReason: 'ฉบับแรก' }, key())
    expect(lintFail).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'RISK_LINT', errors: [{ code: 'RISK_LINT_SCOPE_REQUIRED', question: 'RQ-IS-01', documentType: 'ISO_CERT' }] } } })
    ok(await updateRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: await v(), question: question('RQ-IS-01', { domain: 'INFOSEC', evidenceScopeRequired: true, evidenceScope: 'ISO 27001', options: [{ code: 'Y', labelTh: 'มี', labelEn: 'Yes', points: 0, evidence: true }, { code: 'N', labelTh: 'ไม่มี', labelEn: 'No', points: 12, minTier: 'HIGH' }] }) }, key()))
    ok(await reorderRiskQuestions(as('admin'), { versionId: firstId, expectedVersion: await v(), questionCodes: ['RQ-IS-01', 'RQ-GEN-01', 'RQ-PRV-01'] }, key()))
    expect(await reorderRiskQuestions(as('admin'), { versionId: firstId, expectedVersion: await v(), questionCodes: ['RQ-IS-01'] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'NOT_A_PERMUTATION' } } })
    expect(await submitRiskQuestionnaire(as('admin'), { versionId: firstId, expectedVersion: await v(), effectiveFrom: '2026-11-01T00:00:00+07:00', changeReason: 'ฉบับแรก' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EFFECTIVE_IN_PAST' } } })
    ok(await submitRiskQuestionnaire(as('admin'), { versionId: firstId, expectedVersion: await v(), effectiveFrom, changeReason: 'ฉบับแรก' }, key()))
    const detail = ok(await riskQuestionnaireDetail(as('admin2'), firstId))
    expect(detail).toMatchObject({ status: 'PENDING_PUBLISH', submittedByMe: false, lint: { errors: [] } })
    expect(detail.questionList.map((q) => q.code)).toEqual(['RQ-IS-01', 'RQ-GEN-01', 'RQ-PRV-01'])
    // a sent version is no longer edited
    expect(await removeRiskQuestion(as('admin'), { versionId: firstId, expectedVersion: detail.version, questionCode: 'RQ-GEN-01' }, key())).toMatchObject({ ok: false, error: { code: 'INVALID_STATE_TRANSITION' } })
  })

  it('the sender publishing is refused SAME_EDITOR; a DOA_ADMIN publishes; the version is in effect from its time', async () => {
    const v = (await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: firstId } })).version
    expect(await publishRiskQuestionnaire(as('admin'), { versionId: firstId, expectedVersion: v }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SAME_EDITOR' } } })
    expect(await rejectRiskQuestionnaire(as('admin'), { versionId: firstId, expectedVersion: v, reason: 'ลองตีกลับเอง' }, key())).toMatchObject({ ok: false, error: { details: { reason: 'SAME_EDITOR' } } })
    ok(await publishRiskQuestionnaire(as('auditor'), { versionId: firstId, expectedVersion: v }, key()))
    const row = await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: firstId } })
    expect(row).toMatchObject({ status: 'PUBLISHED', submittedById: org.member.admin, publishedById: org.member.auditor })
    // in effect at its time, not before (BR-RSK-01)
    expect(await tx((t) => questionnaireInEffect(t, NOW))).toBeNull()
    const later = new Date('2026-11-08T06:00:00Z')
    expect((await tx((t) => questionnaireInEffect(t, later)))!.id).toBe(firstId)
    expect(await prisma.event.findFirst({ where: { organizationId: org.organizationId, type: 'risk_questionnaire.published', aggregateId: firstId } })).toMatchObject({ data: { versionNo: 1, submittedById: org.member.admin, publishedById: org.member.auditor } })
    // the dry-run of the question set uses the version's questions and the policy in effect
    const preview = ok(await previewRiskQuestionSet(as('admin', later), firstId, { screening: { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' }, categoryCodes: [], payeeType: 'JURISTIC', isForeign: false }))
    expect(preview).toEqual({ inherentTier: 'HIGH', questions: ['RQ-IS-01', 'RQ-GEN-01', 'RQ-PRV-01'] })
  })

  it('a second version copies the first, is sent back once, then published; the first is superseded when the second takes effect', async () => {
    const later = new Date('2026-11-09T03:00:00Z')
    const secondId = ok(await draftRiskQuestionnaire(as('admin2', later), { code: 'RQ-TEST' }, key())).versionId
    const copied = ok(await riskQuestionnaireDetail(as('admin2', later), secondId))
    expect(copied).toMatchObject({ versionNo: 2, status: 'DRAFT' })
    expect(copied.questionList.map((q) => q.code)).toEqual(['RQ-IS-01', 'RQ-GEN-01', 'RQ-PRV-01'])
    ok(await removeRiskQuestion(as('admin2', later), { versionId: secondId, expectedVersion: copied.version, questionCode: 'RQ-PRV-01' }, key()))
    const v = async () => (await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: secondId } })).version
    const effectiveFrom = new Date('2026-11-12T00:00:00+07:00').toISOString()
    ok(await submitRiskQuestionnaire(as('admin2', later), { versionId: secondId, expectedVersion: await v(), effectiveFrom, changeReason: 'ตัดคำถามข้อมูลส่วนบุคคล' }, key()))
    ok(await rejectRiskQuestionnaire(as('admin', later), { versionId: secondId, expectedVersion: await v(), reason: 'ยังต้องถามข้อมูลส่วนบุคคล' }, key()))
    expect(await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: secondId } })).toMatchObject({ status: 'DRAFT', submittedById: null })
    ok(await submitRiskQuestionnaire(as('admin2', later), { versionId: secondId, expectedVersion: await v(), effectiveFrom, changeReason: 'ตัดคำถามข้อมูลส่วนบุคคล' }, key()))
    ok(await publishRiskQuestionnaire(as('admin', later), { versionId: secondId, expectedVersion: await v() }, key()))
    // published for a later day: the first stays PUBLISHED until then, ending where the second starts
    expect(await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({ status: 'PUBLISHED', effectiveTo: new Date(effectiveFrom) })
    expect((await tx((t) => questionnaireInEffect(t, later)))!.id).toBe(firstId)
    expect(await supersedeDueQuestionnaires(org.organizationId, later)).toBe(0)
    const due = new Date('2026-11-12T01:00:00Z')
    expect(await supersedeDueQuestionnaires(org.organizationId, due)).toBe(1)
    expect(await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({ status: 'SUPERSEDED' })
    expect((await tx((t) => questionnaireInEffect(t, due)))!.id).toBe(secondId)
    // an assessment opened under the first keeps it: the superseded version is still found at its own time
    expect((await tx((t) => questionnaireInEffect(t, later)))!.id).toBe(firstId)
    expect(await supersedeDueQuestionnaires(org.organizationId, due)).toBe(0)
  })
})
