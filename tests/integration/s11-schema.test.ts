import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { transition, RISK_ASSESSMENT_MACHINE } from '@/core/state-machines'
import { prisma } from '@/server/db/client'

// S11-01 (docs/sub-specs/S11.md "Entity และ migration" · ADR-221 to ADR-229): the one migration of S11 against real
// Postgres (ADR-027) — the partial uniques of INV-RSK-02, the shape of a COMPLETED and a SUPERSEDED assessment and the
// trigger that freezes their answers (INV-RSK-03), the light 4-eyes of the thresholds (BR-RSK-02) and the override's cap
// and day (BR-RSK-10) hold what the services of S11-04 to S11-09 will rely on.

const NOW = new Date('2026-11-02T03:00:00Z')
let orgId: string
let memberId: string
let member2Id: string
let supplierId: string
let questionnaireId: string
let workflowVersionId: string

const options = [
  { code: 'Y', labelTh: 'ใช่', labelEn: 'Yes', points: 3 },
  { code: 'N', labelTh: 'ไม่ใช่', labelEn: 'No', points: 0 },
]

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { code: `S11-${randomUUID().slice(0, 8)}`, legalNameTh: 'S11 schema', taxId: '0999999000055', settings: {} } })
  orgId = org.id
  const member = (name: string) => prisma.member.create({ data: { organizationId: orgId, displayNameTh: name, email: `s11-${randomUUID().slice(0, 8)}@test.bcs.local`, status: 'ACTIVE' } })
  memberId = (await member('จัดซื้อ')).id
  member2Id = (await member('ผู้ดูแล')).id
  supplierId = (await prisma.supplier.create({ data: { organizationId: orgId, code: 'S11-SUP', nameTh: 'ผู้ขาย S11', isForeign: true } })).id
  questionnaireId = (
    await prisma.riskQuestionnaire.create({
      data: { organizationId: orgId, code: 'RQ-TEST', versionNo: 1, status: 'PUBLISHED', effectiveFrom: NOW, submittedById: memberId, submittedAt: NOW, publishedById: member2Id, publishedAt: NOW },
    })
  ).id
  workflowVersionId = (await prisma.workflowVersion.create({ data: { organizationId: orgId, code: 'WF-S11', versionNo: 1, effectiveFrom: NOW } })).id
})

const supplier = async () => (await prisma.supplier.create({ data: { organizationId: orgId, code: `S11-${randomUUID().slice(0, 6)}`, nameTh: 'ผู้ขาย', isForeign: true } })).id
const assessment = (data: Record<string, unknown> = {}) =>
  prisma.riskAssessment.create({
    data: { organizationId: orgId, supplierId, questionnaireId, screening: { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' }, categoryCodes: ['IT'], payeeType: 'JURISTIC', workScopes: [], inherentTier: 'HIGH', lastActivityAt: NOW, openedById: memberId, ...data },
  })
const completed = { status: 'COMPLETED' as const, tier: 'HIGH' as const, pointsTotal: 12, submittedAt: NOW, completedAt: NOW, completedOn: new Date('2026-11-02'), validUntil: new Date('2027-11-02'), remindOn: new Date('2027-10-03') }

describe('[INV-RSK-02] one open assessment, one COMPLETED and one open override per supplier', () => {
  it('a second open assessment of the supplier is refused; a cancelled one frees the place', async () => {
    const sid = await supplier()
    const first = await assessment({ supplierId: sid })
    await expect(assessment({ supplierId: sid })).rejects.toThrow(/Unique constraint/)
    await expect(assessment({ supplierId: sid, status: 'RETURNED', submittedAt: NOW, tier: 'HIGH', pointsTotal: 1 })).rejects.toThrow(/Unique constraint/)
    await prisma.riskAssessment.update({ where: { id: first.id }, data: { status: 'CANCELLED' } })
    await expect(assessment({ supplierId: sid })).resolves.toBeTruthy()
  })

  it('two COMPLETED assessments of one supplier are refused; the older one must be SUPERSEDED first', async () => {
    const sid = await supplier()
    const older = await assessment({ supplierId: sid, ...completed })
    await expect(assessment({ supplierId: sid, ...completed })).rejects.toThrow(/Unique constraint/)
    const newer = await assessment({ supplierId: sid })
    await prisma.riskAssessment.update({ where: { id: older.id }, data: { status: 'SUPERSEDED', supersededById: newer.id } })
    await expect(prisma.riskAssessment.update({ where: { id: newer.id }, data: completed })).resolves.toBeTruthy()
  })

  it('a second open override of the supplier is refused; a rejected one frees the place', async () => {
    const sid = await supplier()
    const override = (data: Record<string, unknown> = {}) =>
      prisma.riskOverride.create({ data: { organizationId: orgId, supplierId: sid, reason: 'ผู้ขายรายเดียวในพื้นที่ ต้องเริ่มงานก่อนประเมินเสร็จ', capGrossSatang: 50_000_000n, expiresOn: new Date('2026-12-31'), requestedById: memberId, ...data } })
    const first = await override()
    await expect(override()).rejects.toThrow(/Unique constraint/)
    await prisma.riskOverride.update({ where: { id: first.id }, data: { status: 'REJECTED', submittedAt: NOW, decidedAt: NOW } })
    await expect(override()).resolves.toBeTruthy()
  })
})

describe('[INV-RSK-03] a COMPLETED or SUPERSEDED assessment keeps its result, and its answers are frozen', () => {
  it('the state machine pair COMPLETED → SUPERSEDED holds against the CHECK on Postgres', async () => {
    expect(transition(RISK_ASSESSMENT_MACHINE, 'COMPLETED', 'riskAssessment.supersede')).toEqual({ ok: true, to: 'SUPERSEDED' })
    const sid = await supplier()
    const older = await assessment({ supplierId: sid, ...completed })
    const newer = await assessment({ supplierId: sid })
    // SUPERSEDED keeps completedAt, tier and validUntil, and names what superseded it
    await expect(prisma.riskAssessment.update({ where: { id: older.id }, data: { status: 'SUPERSEDED' } })).rejects.toThrow(/risk_assessment_shape/)
    await expect(prisma.riskAssessment.update({ where: { id: older.id }, data: { status: 'SUPERSEDED', supersededById: newer.id, completedAt: null } })).rejects.toThrow(/risk_assessment_shape/)
    const row = await prisma.riskAssessment.update({ where: { id: older.id }, data: { status: 'SUPERSEDED', supersededById: newer.id } })
    expect(row).toMatchObject({ status: 'SUPERSEDED', tier: 'HIGH', pointsTotal: 12 })
    expect(row.validUntil).toEqual(completed.validUntil)
  })

  it('only COMPLETED and SUPERSEDED carry completedAt, tier and validUntil; a submitted one has its frozen tier', async () => {
    await expect(assessment({ supplierId: await supplier(), status: 'COMPLETED' })).rejects.toThrow(/risk_assessment_shape/)
    await expect(assessment({ supplierId: await supplier(), status: 'IN_REVIEW', submittedAt: NOW })).rejects.toThrow(/risk_assessment_shape/)
    await expect(assessment({ supplierId: await supplier(), completedAt: NOW, completedOn: new Date('2026-11-02'), tier: 'LOW', validUntil: new Date('2029-11-02') })).rejects.toThrow(/risk_assessment_shape/)
    await expect(assessment({ supplierId: await supplier(), status: 'IN_REVIEW', submittedAt: NOW, tier: 'MEDIUM', pointsTotal: 5 })).resolves.toBeTruthy()
  })

  it('risk_answer_frozen refuses a change, a new answer and a delete once the assessment is COMPLETED', async () => {
    const sid = await supplier()
    const a = await assessment({ supplierId: sid })
    const answer = await prisma.riskAnswer.create({ data: { organizationId: orgId, assessmentId: a.id, questionCode: 'RQ-GEN-01', optionCode: 'Y', source: 'ON_BEHALF', points: 3, answeredAt: NOW, answeredByMemberId: memberId } })
    // a draft's answers change freely (the history is in Event)
    await prisma.riskAnswer.update({ where: { id: answer.id }, data: { optionCode: 'N', points: 0 } })
    await prisma.riskAssessment.update({ where: { id: a.id }, data: { ...completed, pointsTotal: 0, tier: 'LOW' } })
    await expect(prisma.riskAnswer.update({ where: { id: answer.id }, data: { points: 3 } })).rejects.toThrow(/risk_answer_frozen/)
    await expect(prisma.riskAnswer.delete({ where: { id: answer.id } })).rejects.toThrow(/risk_answer_frozen/)
    await expect(
      prisma.riskAnswer.create({ data: { organizationId: orgId, assessmentId: a.id, questionCode: 'RQ-GEN-02', optionCode: 'N', source: 'ON_BEHALF', points: 0, answeredAt: NOW, answeredByMemberId: memberId } }),
    ).rejects.toThrow(/risk_answer_frozen/)
    expect(await prisma.riskAnswer.findUniqueOrThrow({ where: { id: answer.id } })).toMatchObject({ optionCode: 'N', points: 0 })
  })

  it('an answer from evidence names its document; one given by a person names who', async () => {
    const a = await assessment({ supplierId: await supplier() })
    const base = { organizationId: orgId, assessmentId: a.id, optionCode: 'Y', points: 3, answeredAt: NOW }
    await expect(prisma.riskAnswer.create({ data: { ...base, questionCode: 'RQ-IS-01', source: 'EVIDENCE' } })).rejects.toThrow(/risk_answer_shape/)
    await expect(prisma.riskAnswer.create({ data: { ...base, questionCode: 'RQ-IS-02', source: 'EXPLICIT' } })).rejects.toThrow(/risk_answer_shape/)
    await expect(prisma.riskAnswer.create({ data: { ...base, questionCode: 'RQ-IS-03', source: 'EXPLICIT', note: 'x'.repeat(501), answeredByMemberId: memberId } })).rejects.toThrow(/risk_answer_shape/)
  })
})

describe('[BR-RSK-02] thresholds, policy and questionnaire versions have a light 4-eyes', () => {
  it('a tier is confirmed by someone other than who proposed it; LOW starts at 0; a pending change names its proposer', async () => {
    const org = await prisma.organization.create({ data: { code: `S11T-${randomUUID().slice(0, 6)}`, legalNameTh: 'tiers', taxId: '0999999000055', settings: {} } })
    const m = (await prisma.member.create({ data: { organizationId: org.id, displayNameTh: 'ผู้ดูแล', email: `t-${randomUUID().slice(0, 8)}@test.bcs.local`, status: 'ACTIVE' } })).id
    const tier = (data: Record<string, unknown>) => prisma.riskTier.create({ data: { organizationId: org.id, nameTh: 'ระดับ', nameEn: 'Tier', reviewMonths: 12, updatedById: m, ...data } as never })
    await expect(tier({ code: 'LOW', minPoints: 3 })).rejects.toThrow(/risk_tier_shape/)
    await expect(tier({ code: 'MEDIUM', minPoints: 5, confirmedById: m, confirmedAt: NOW })).rejects.toThrow(/risk_tier_shape/)
    await expect(tier({ code: 'MEDIUM', minPoints: 5, reviewMonths: 0 })).rejects.toThrow(/risk_tier_shape/)
    await expect(tier({ code: 'MEDIUM', minPoints: 5, pendingChange: { minPoints: 6 } })).rejects.toThrow(/risk_tier_shape/)
    await expect(tier({ code: 'LOW', minPoints: 0, confirmedById: memberId, confirmedAt: NOW })).rejects.toThrow(/Foreign key|violates/)
    await expect(tier({ code: 'MEDIUM', minPoints: 5, pendingChange: { minPoints: 6 }, pendingById: m, pendingAt: NOW })).resolves.toBeTruthy()
    await expect(tier({ code: 'MEDIUM', minPoints: 7 })).rejects.toThrow(/Unique constraint/)
  })

  it('one policy row per organization, confirmed by someone else', async () => {
    const policy = (data: Record<string, unknown> = {}) =>
      prisma.riskPolicy.create({
        data: { organizationId: orgId, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: memberId, ...data },
      })
    await expect(policy({ confirmedById: memberId, confirmedAt: NOW })).rejects.toThrow(/risk_policy_shape/)
    await expect(policy({ confirmedById: member2Id, confirmedAt: NOW })).resolves.toBeTruthy()
    await expect(policy({ confirmedById: member2Id, confirmedAt: NOW })).rejects.toThrow(/Unique constraint/)
  })

  it('a published version names a publisher other than its submitter', async () => {
    const version = (data: Record<string, unknown>) => prisma.riskQuestionnaire.create({ data: { organizationId: orgId, code: 'RQ-4EYES', effectiveFrom: NOW, ...data } as never })
    await expect(version({ versionNo: 1, status: 'PUBLISHED', submittedById: memberId, submittedAt: NOW, publishedById: memberId, publishedAt: NOW })).rejects.toThrow(/risk_questionnaire_shape/)
    await expect(version({ versionNo: 1, status: 'PENDING_PUBLISH' })).rejects.toThrow(/risk_questionnaire_shape/)
    await expect(version({ versionNo: 1, status: 'PUBLISHED', submittedById: memberId, submittedAt: NOW, publishedById: member2Id, publishedAt: NOW })).resolves.toBeTruthy()
  })

  it('a question has the RQ code format and at least two options, and a scope when one is required (BR-RSK-05)', async () => {
    const question = (data: Record<string, unknown>) =>
      prisma.riskQuestion.create({ data: { organizationId: orgId, questionnaireId, domain: 'INFOSEC', textTh: 'คำถาม', textEn: 'Question', options, ...data } as never })
    await expect(question({ code: 'RA-01' })).rejects.toThrow(/risk_question_shape/)
    await expect(question({ code: 'RQ-IS-09', options: [options[0]] })).rejects.toThrow(/risk_question_shape/)
    await expect(question({ code: 'RQ-IS-08', evidenceScopeRequired: true })).rejects.toThrow(/risk_question_shape/)
    await expect(question({ code: 'RQ-IS-01', evidenceScopeRequired: true, evidenceScope: 'ISO 27001' })).resolves.toBeTruthy()
  })
})

describe('[BR-RSK-10] an override has a positive cap, uses it cumulatively, and is valid at least on the day it is sent', () => {
  const override = async (data: Record<string, unknown>) =>
    prisma.riskOverride.create({ data: { organizationId: orgId, supplierId: await supplier(), reason: 'ผู้ขายรายเดียวในพื้นที่', expiresOn: new Date('2026-11-30'), requestedById: memberId, capGrossSatang: 1_000_000n, ...data } as never })

  it('cap > 0 and 0 ≤ usedGrossSatang ≤ cap', async () => {
    await expect(override({ capGrossSatang: 0n })).rejects.toThrow(/risk_override_shape/)
    await expect(override({ usedGrossSatang: 1_000_001n })).rejects.toThrow(/risk_override_shape/)
    await expect(override({ usedGrossSatang: -1n })).rejects.toThrow(/risk_override_shape/)
    await expect(override({ usedGrossSatang: 1_000_000n, usedCount: 2 })).resolves.toBeTruthy()
  })

  it('expiresOn on or after the Bangkok day of submittedAt (GC-RSK ข้อ 72)', async () => {
    // 2026-11-02T18:00Z is 3 November in Bangkok
    const submittedAt = new Date('2026-11-02T18:00:00Z')
    await expect(override({ status: 'PENDING_APPROVAL', submittedAt, expiresOn: new Date('2026-11-02') })).rejects.toThrow(/risk_override_shape/)
    await expect(override({ status: 'PENDING_APPROVAL', submittedAt, expiresOn: new Date('2026-11-03') })).resolves.toBeTruthy()
    await expect(override({ status: 'APPROVED', submittedAt, expiresOn: new Date('2026-11-03') })).rejects.toThrow(/risk_override_shape/)
  })
})

describe('[BR-RSK-07] reviewer tasks and risk rules of a workflow', () => {
  it('a decided task names when and who, a returned one its reason, a cancelled one why; one task per slot of a round', async () => {
    const a = await assessment({ supplierId: await supplier(), status: 'IN_REVIEW', submittedAt: NOW, tier: 'HIGH', pointsTotal: 9 })
    const task = (data: Record<string, unknown>) =>
      prisma.reviewTask.create({ data: { organizationId: orgId, assessmentId: a.id, reviewRound: 1, workflowVersionId, ruleCodes: ['RR-01'], groupNo: 1, slotNo: 1, riskDomains: ['PRIVACY'], assigneeMemberId: member2Id, assignedAt: NOW, dueAt: NOW, ...data } as never })
    await expect(task({ status: 'PASSED' })).rejects.toThrow(/review_task_shape/)
    await expect(task({ status: 'RETURNED', decidedAt: NOW, decidedById: member2Id })).rejects.toThrow(/review_task_shape/)
    await expect(task({ status: 'CANCELLED' })).rejects.toThrow(/review_task_shape/)
    await expect(task({ riskDomains: [] })).rejects.toThrow(/review_task_shape/)
    await expect(task({})).resolves.toBeTruthy()
    await expect(task({})).rejects.toThrow(/Unique constraint/)
    await expect(task({ slotNo: 2, status: 'RETURNED', decidedAt: NOW, decidedById: member2Id, reasonCommentId: randomUUID() })).resolves.toBeTruthy()
  })

  it('a rule of RISK_ASSESSMENT scope names the parts its reviewers see; a request rule names none', async () => {
    const rule = (data: Record<string, unknown>) =>
      prisma.workflowRule.create({ data: { organizationId: orgId, workflowVersionId, code: `RR-${randomUUID().slice(0, 4)}`, requestTypeCodes: [], when: {}, reviewers: [], mode: 'ALL', slaBusinessMinutes: 960, ...data } as never })
    await expect(rule({ scope: 'RISK_ASSESSMENT' })).rejects.toThrow(/workflow_rule_risk_scope/)
    await expect(rule({ riskDomains: ['PRIVACY'] })).rejects.toThrow(/workflow_rule_risk_scope/)
    await expect(rule({ scope: 'RISK_ASSESSMENT', riskDomains: ['PRIVACY'] })).resolves.toMatchObject({ scope: 'RISK_ASSESSMENT' })
    await expect(rule({})).resolves.toMatchObject({ scope: 'REQUEST', riskDomains: [] })
  })
})

describe('[FR-RSK-205] [BR-RSK-12] reassessments', () => {
  it('one open review per reason per supplier; DONE names the assessment; STATUS_CHANGED names its flag', async () => {
    const sid = await supplier()
    const review = (data: Record<string, unknown>) => prisma.riskReview.create({ data: { organizationId: orgId, supplierId: sid, dueAt: NOW, ...data } as never })
    await expect(review({ reason: 'STATUS_CHANGED' })).rejects.toThrow(/risk_review_shape/)
    await expect(review({ reason: 'OVERRIDE_EXPIRED' })).rejects.toThrow(/risk_review_shape/)
    const first = await review({ reason: 'SCHEDULED', tier: 'HIGH' })
    await expect(review({ reason: 'SCHEDULED' })).rejects.toThrow(/Unique constraint/)
    await expect(review({ reason: 'STATUS_CHANGED', registryFlag: 'CEASED' })).resolves.toBeTruthy()
    await expect(prisma.riskReview.update({ where: { id: first.id }, data: { status: 'DONE' } })).rejects.toThrow(/risk_review_shape/)
    const a = await assessment({ supplierId: sid, ...completed })
    await prisma.riskReview.update({ where: { id: first.id }, data: { status: 'DONE', completedAt: NOW, completedByAssessmentId: a.id } })
    await expect(review({ reason: 'SCHEDULED' })).resolves.toBeTruthy()
  })
})
