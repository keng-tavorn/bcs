import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { answerRiskAssessment, applyRiskRegistryFlag, openRiskAssessment, runRiskReviewDaily, submitRiskAssessment } from '@/server/services/risk'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S11-09 (FR-RSK-205 AC1 AC2 AC3 AC4 · BR-RSK-10 BR-RSK-12 BR-RSK-13 BR-RSK-14 · ADR-227) against Postgres with an injected
// clock: the job risk-review-daily run as Inngest runs it (runRiskReviewDaily for one organization at 07:15 Asia/Bangkok
// of a day). Scene 20 of docs/sub-specs/S11.md: a HIGH assessment completed on 2025-12-15 (SP0132 of the seed) is valid
// until 2026-12-15 and reminded from 2026-11-15 (GC-RSK-66) — that day the job opens the RiskReview and the new
// assessment; on 2026-12-16 the supplier is OVERDUE (GC-RSK-68); the new assessment completed supersedes the old one.
// The tiers, the policy and the questions are test data of the organization (the demo values of OQ-221 OQ-222 OQ-226).

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
/** 07:15 Asia/Bangkok of a day: the cron of risk-review-daily */
const morning = (day: string) => new Date(`${day}T07:15:00+07:00`)
const COMPLETED_AT = new Date('2025-12-15T03:00:00Z')
let org: DoaOrg
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const daily = (day: string, o: DoaOrg = org) => runRiskReviewDaily(o.organizationId, morning(day), { sender: null })

const yn = (no: number) => [
  { code: 'Y', labelTh: 'ใช่', labelEn: 'Yes', points: 0 },
  { code: 'N', labelTh: 'ไม่ใช่', labelEn: 'No', points: no },
]
const QUESTIONS = [
  { code: 'RQ-GEN-01', domain: 'GENERAL' as const, options: yn(25), sortOrder: 10 },
  { code: 'RQ-PRV-01', domain: 'PRIVACY' as const, options: yn(20), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 20 },
]
/** Personal data: HIGH by the screening map (scene 20's security guard reaches the premises; the tier is what counts) */
const SCREEN_HIGH = { processesPersonalData: 'Y' as const, accessesSystems: 'N' as const, accessesPremises: 'N' as const }

async function riskOrg(o: DoaOrg, options: { module?: boolean } = {}) {
  const id = o.organizationId
  const at = new Date('2025-01-01T00:00:00+07:00')
  if (options.module !== false) await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: at, contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({ data: [{ organizationId: id, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: at }] })
  for (const t of [
    { code: 'LOW' as const, minPoints: 0, reviewMonths: 36, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'MEDIUM' as const, minPoints: 20, reviewMonths: 24, blocksPo: false, requiresExplicitAnswers: false },
    { code: 'HIGH' as const, minPoints: 40, reviewMonths: 12, blocksPo: true, requiresExplicitAnswers: true },
  ]) {
    await prisma.riskTier.create({ data: { organizationId: id, ...t, nameTh: t.code, nameEn: t.code, reminderDaysBefore: 30, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: at } })
  }
  await prisma.riskPolicy.create({
    data: { organizationId: id, screeningTierMap: { processesPersonalData: 'HIGH', accessesSystems: 'MEDIUM', accessesPremises: 'MEDIUM' }, highRiskCategories: ['PROF'], registryFlagBlocks: true, mediumOverdueBlocks: false, overrideChatButton: false, updatedById: o.member.admin!, confirmedById: o.member.admin2!, confirmedAt: at },
  })
  const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: at, submittedById: o.member.admin!, submittedAt: at, publishedById: o.member.admin2!, publishedAt: at, checksum: 'test' } })
  for (const question of QUESTIONS) await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, textTh: question.code, textEn: question.code, ...question } })
  return q.id
}

async function supplierWithContact(code: string, o: DoaOrg = org) {
  const supplier = await prisma.supplier.create({ data: { organizationId: o.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true, portalEnabled: true, email: `${code.toLowerCase()}@supplier.test` } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: o.organizationId, supplierId: supplier.id, nameTh: `ผู้ติดต่อ ${code}`, email: `c-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  return { supplierId: supplier.id, portal: (now: Date) => portalCtx(o.organizationId, contact, now) }
}

const version = async (id: string) => (await prisma.riskAssessment.findUniqueOrThrow({ where: { id } })).version
const supplierOf = (id: string) => prisma.supplier.findUniqueOrThrow({ where: { id }, select: { riskStatus: true, riskTier: true, riskValidUntil: true, currentRiskAssessmentId: true } })
const eventsOf = (aggregateId: string, type: string) => prisma.event.findMany({ where: { aggregateId, type }, orderBy: { seq: 'asc' } })

/** An assessment answered by the contact and sent at `at`: COMPLETED at once (no reviewer rule in this organization) */
async function assessedAt(s: Awaited<ReturnType<typeof supplierWithContact>>, at: Date, o: DoaOrg = org) {
  const opened = ok(await openRiskAssessment(o.ctxOf('proc_officer', at), { supplierId: s.supplierId, screening: SCREEN_HIGH, categoryCodes: ['SEC'], workScopes: ['ISO 45001'] }, key()))
  return answerAndSend(s, opened.assessmentId, at)
}
async function answerAndSend(s: Awaited<ReturnType<typeof supplierWithContact>>, assessmentId: string, at: Date) {
  ok(await answerRiskAssessment(s.portal(at), { assessmentId, expectedVersion: await version(assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }, { questionCode: 'RQ-PRV-01', optionCode: 'Y' }] }, key()))
  expect(ok(await submitRiskAssessment(s.portal(at), { assessmentId, expectedVersion: await version(assessmentId) }, key()))).toMatchObject({ status: 'COMPLETED', tier: 'HIGH' })
  return assessmentId
}

/** An override APPROVED until `expiresOn` (its route is S11-08's; here only what the job reads) */
async function approvedOverride(supplierId: string, expiresOn: string) {
  return prisma.riskOverride.create({
    data: { organizationId: org.organizationId, number: `RO-T-${randomUUID().slice(0, 6)}`, supplierId, reason: 'งานด่วน', capGrossSatang: 12_000_000n, expiresOn: new Date(expiresOn), requestedById: org.member.proc_officer!, submittedAt: COMPLETED_AT, decidedAt: COMPLETED_AT, status: 'APPROVED' },
  })
}

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await riskOrg(org)
})

describe('[FR-RSK-205/AC1] the reassessment dates of the tier and the state of each day (scene 20)', () => {
  it('a HIGH assessment completed on 2025-12-15: validUntil 2026-12-15, remindOn 2026-11-15; CURRENT the day before', async () => {
    const s = await supplierWithContact('RR-AC1')
    const id = await assessedAt(s, COMPLETED_AT)
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id } })).toMatchObject({ tier: 'HIGH', completedOn: new Date('2025-12-15'), validUntil: new Date('2026-12-15'), remindOn: new Date('2026-11-15') })
    expect(await supplierOf(s.supplierId)).toMatchObject({ riskStatus: 'CURRENT', riskTier: 'HIGH', riskValidUntil: new Date('2026-12-15') })
    // 2026-11-14 (GC-RSK-65): nothing is due
    await daily('2026-11-14')
    expect(await prisma.riskReview.count({ where: { supplierId: s.supplierId } })).toBe(0)
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('CURRENT')
  })
})

describe('[FR-RSK-205/AC2] risk-review-daily: the reassessment at remindOn, OVERDUE after validUntil, overrides and versions', () => {
  it('2026-11-15: a RiskReview SCHEDULED, a new assessment opened with the old work and no old answer, the reminder e-mail, EXPIRING', async () => {
    const s = await supplierWithContact('RR-AC2')
    const old = await assessedAt(s, COMPLETED_AT)
    const run = await daily('2026-11-15')
    expect(run.reviewsScheduled).toBeGreaterThanOrEqual(1)
    const review = await prisma.riskReview.findFirstOrThrow({ where: { supplierId: s.supplierId } })
    expect(review).toMatchObject({ reason: 'SCHEDULED', status: 'OPEN', tier: 'HIGH', sourceAssessmentId: old, dueAt: new Date('2026-12-15T10:30:00Z') })
    const opened = await prisma.riskAssessment.findFirstOrThrow({ where: { supplierId: s.supplierId, status: 'DRAFT' }, include: { answers: true } })
    expect(opened).toMatchObject({ screening: SCREEN_HIGH, categoryCodes: ['SEC'], workScopes: ['ISO 45001'], inherentTier: 'HIGH', openedById: org.member.proc_officer })
    expect(opened.number).toMatch(/^RSA-\d{4}-\d{5}$/)
    // the old answers are confirmed again, never copied (OQ-226)
    expect(opened.answers).toHaveLength(0)
    const [scheduled] = await eventsOf(review.id, 'risk_review.scheduled')
    expect(scheduled).toMatchObject({ actorType: 'SYSTEM', data: { reason: 'SCHEDULED', supplierId: s.supplierId, openedAssessmentId: opened.id, sourceAssessmentId: old } })
    expect(await eventsOf(opened.id, 'risk_assessment.opened')).toHaveLength(1)
    // the supplier's contact gets the reminder with a link to the new assessment; PROCUREMENT in the day's digest
    expect(await prisma.supplierNotice.findMany({ where: { supplierId: s.supplierId, subjectId: opened.id }, select: { templateKey: true } })).toEqual([{ templateKey: 'supplier.risk_reminder' }])
    const notices = await prisma.notification.findMany({ where: { subjectId: s.supplierId, templateKey: 'risk.review_due' } })
    expect(notices.length).toBeGreaterThan(0)
    expect(notices.every((n) => n.urgency === 'DIGEST')).toBe(true)
    expect(await supplierOf(s.supplierId)).toMatchObject({ riskStatus: 'EXPIRING', currentRiskAssessmentId: old })

    // the same day again, and the days after: no second review, no second assessment
    await daily('2026-11-15')
    await daily('2026-11-16')
    expect(await prisma.riskReview.count({ where: { supplierId: s.supplierId } })).toBe(1)
    expect(await prisma.riskAssessment.count({ where: { supplierId: s.supplierId } })).toBe(2)

    // 2026-12-15 (GC-RSK-67) still EXPIRING; 2026-12-16 (GC-RSK-68) OVERDUE although the new one is open
    await daily('2026-12-15')
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('EXPIRING')
    await daily('2026-12-16')
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('OVERDUE')
    expect(await eventsOf(s.supplierId, 'supplier.risk_status_changed')).toEqual(expect.arrayContaining([expect.objectContaining({ data: { from: 'EXPIRING', to: 'OVERDUE' } })]))
    expect(await eventsOf(review.id, 'risk_review.overdue')).toHaveLength(1)
    expect(await prisma.notification.count({ where: { subjectId: s.supplierId, templateKey: 'risk.status_changed', urgency: 'DIGEST' } })).toBeGreaterThan(0)
    await daily('2026-12-17')
    expect(await eventsOf(review.id, 'risk_review.overdue')).toHaveLength(1)
    expect((await prisma.riskReview.findUniqueOrThrow({ where: { id: review.id } })).status).toBe('OPEN')
  })

  it('an override within seven days of its last day is told once; past it EXPIRED, with a review when no valid assessment stands', async () => {
    const bare = await supplierWithContact('RR-OVR')
    const assessed = await supplierWithContact('RR-OVR-OK')
    await assessedAt(assessed, new Date('2026-11-01T03:00:00Z'))
    const lone = await approvedOverride(bare.supplierId, '2027-01-20')
    const covered = await approvedOverride(assessed.supplierId, '2027-01-20')
    await daily('2027-01-12')
    expect(await eventsOf(lone.id, 'risk_override.expiring')).toHaveLength(0)
    await daily('2027-01-13')
    await daily('2027-01-14')
    const [expiring] = await eventsOf(lone.id, 'risk_override.expiring')
    expect(await eventsOf(lone.id, 'risk_override.expiring')).toHaveLength(1)
    expect(expiring).toMatchObject({ data: { expiresOn: '2027-01-20', daysLeft: 7 } })
    // the requester and PROCUREMENT, in the day's digest
    const told = await prisma.notification.findMany({ where: { subjectId: lone.id, templateKey: 'risk.override_expiring' }, select: { recipientMemberId: true, urgency: true } })
    expect(told.map((n) => n.recipientMemberId)).toContain(org.member.proc_officer)
    expect(told.every((n) => n.urgency === 'DIGEST')).toBe(true)
    // its last day counts: still APPROVED on 2027-01-20
    await daily('2027-01-20')
    expect((await prisma.riskOverride.findUniqueOrThrow({ where: { id: lone.id } })).status).toBe('APPROVED')
    await daily('2027-01-21')
    expect(await prisma.riskOverride.findUniqueOrThrow({ where: { id: lone.id } })).toMatchObject({ status: 'EXPIRED' })
    expect(await eventsOf(lone.id, 'risk_override.expired')).toEqual([expect.objectContaining({ data: expect.objectContaining({ expiresOn: '2027-01-20', reviewScheduled: true }) })])
    expect(await prisma.riskReview.findFirstOrThrow({ where: { supplierId: bare.supplierId } })).toMatchObject({ reason: 'OVERRIDE_EXPIRED', status: 'OPEN', sourceOverrideId: lone.id, dueAt: new Date('2027-01-20T10:30:00Z') })
    // a supplier with a valid assessment: EXPIRED, no review
    expect((await prisma.riskOverride.findUniqueOrThrow({ where: { id: covered.id } })).status).toBe('EXPIRED')
    expect(await prisma.riskReview.count({ where: { supplierId: assessed.supplierId, reason: 'OVERRIDE_EXPIRED' } })).toBe(0)
    await daily('2027-01-22')
    expect(await eventsOf(lone.id, 'risk_override.expired')).toHaveLength(1)
  })

  it('a version whose time has come supersedes the one before; a supplier no longer ACTIVE has its open reviews cancelled', async () => {
    const o = await createP2Org()
    const v1 = await riskOrg(o)
    const v2 = await prisma.riskQuestionnaire.create({ data: { organizationId: o.organizationId, code: 'RQ-T', versionNo: 2, status: 'PUBLISHED', effectiveFrom: new Date('2026-11-20T00:00:00+07:00'), submittedById: o.member.admin!, submittedAt: COMPLETED_AT, publishedById: o.member.admin2!, publishedAt: COMPLETED_AT, checksum: 'test' } })
    await daily('2026-11-19', o)
    expect((await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: v1 } })).status).toBe('PUBLISHED')
    expect((await daily('2026-11-20', o)).questionnairesSuperseded).toBe(1)
    expect(await prisma.riskQuestionnaire.findUniqueOrThrow({ where: { id: v1 } })).toMatchObject({ status: 'SUPERSEDED', effectiveTo: v2.effectiveFrom })

    const s = await supplierWithContact('RR-INACT', o)
    ok(await applyRiskRegistryFlag(o.organizationId, s.supplierId, 'NOT_FOUND', morning('2026-11-20'), { sender: null }))
    await prisma.supplier.update({ where: { id: s.supplierId }, data: { status: 'INACTIVE' } })
    expect((await daily('2026-11-21', o)).reviewsCancelled).toBe(1)
    const review = await prisma.riskReview.findFirstOrThrow({ where: { supplierId: s.supplierId } })
    expect(review).toMatchObject({ status: 'CANCELLED', cancelReason: 'SUPPLIER_INACTIVE' })
    expect(await eventsOf(review.id, 'risk_review.cancelled')).toHaveLength(1)
  })

  it('RISK off: the job does nothing for the organization (MODULE_DISABLED on its commands)', async () => {
    const off = await createP2Org()
    await riskOrg(off, { module: false })
    const s = await supplierWithContact('RR-OFF', off)
    await prisma.riskOverride.create({ data: { organizationId: off.organizationId, number: 'RO-OFF', supplierId: s.supplierId, reason: 'x', capGrossSatang: 1n, expiresOn: new Date('2026-01-01'), requestedById: off.member.proc_officer!, submittedAt: COMPLETED_AT, decidedAt: COMPLETED_AT, status: 'APPROVED' } })
    expect(await daily('2026-11-20', off)).toEqual({ questionnairesSuperseded: 0, overridesExpiring: 0, overridesExpired: 0, reviewsScheduled: 0, reviewsCancelled: 0, suppliersRefreshed: 0 })
    expect(await applyRiskRegistryFlag(off.organizationId, s.supplierId, 'CEASED', morning('2026-11-20'), { sender: null })).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    expect(await prisma.riskReview.count({ where: { supplierId: s.supplierId } })).toBe(0)
  })
})

describe('[FR-RSK-205/AC3] [BR-RSK-12] a registry flag puts the supplier in REASSESS_REQUIRED at once; NONE cancels it', () => {
  it('CEASED: a RiskReview STATUS_CHANGED, REASSESS_REQUIRED over CURRENT, PROCUREMENT told at once; NONE: CANCELLED, CURRENT again', async () => {
    const s = await supplierWithContact('RR-FLAG')
    await assessedAt(s, new Date('2026-11-01T03:00:00Z'))
    const at = morning('2026-11-20')
    const flagged = ok(await applyRiskRegistryFlag(org.organizationId, s.supplierId, 'CEASED', at, { sender: null }))
    const review = await prisma.riskReview.findUniqueOrThrow({ where: { id: flagged.reviewId! } })
    expect(review).toMatchObject({ reason: 'STATUS_CHANGED', status: 'OPEN', registryFlag: 'CEASED', tier: 'HIGH', dueAt: at })
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('REASSESS_REQUIRED')
    const told = await prisma.notification.findMany({ where: { subjectId: s.supplierId, templateKey: 'risk.status_changed' } })
    expect(told.length).toBeGreaterThan(0)
    expect(told.every((n) => n.urgency === 'IMMEDIATE')).toBe(true)
    // a second flag while one is open changes nothing; the day's job keeps REASSESS_REQUIRED
    expect(await applyRiskRegistryFlag(org.organizationId, s.supplierId, 'VAT_CANCELLED', at, { sender: null })).toMatchObject({ ok: false })
    await daily('2026-11-21')
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('REASSESS_REQUIRED')
    ok(await applyRiskRegistryFlag(org.organizationId, s.supplierId, 'NONE', morning('2026-11-22'), { sender: null }))
    expect(await prisma.riskReview.findUniqueOrThrow({ where: { id: review.id } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'REGISTRY_CLEARED' })
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('CURRENT')
    expect(await prisma.riskReview.count({ where: { supplierId: s.supplierId, status: 'OPEN' } })).toBe(0)
  })
})

describe('[FR-RSK-205/AC4] the reassessment is a new assessment: completed, it supersedes the old and closes every review', () => {
  it('the assessment the job opened, answered and sent: the old SUPERSEDED, the reviews DONE, CURRENT with new dates', async () => {
    const s = await supplierWithContact('RR-AC4')
    const old = await assessedAt(s, COMPLETED_AT)
    await daily('2026-11-15')
    const flagged = ok(await applyRiskRegistryFlag(org.organizationId, s.supplierId, 'NOT_FOUND', morning('2026-12-01'), { sender: null }))
    await daily('2026-12-16')
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('REASSESS_REQUIRED')
    const renewal = await prisma.riskAssessment.findFirstOrThrow({ where: { supplierId: s.supplierId, status: 'DRAFT' } })
    await answerAndSend(s, renewal.id, new Date('2026-12-20T03:00:00Z'))
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: old } })).toMatchObject({ status: 'SUPERSEDED', supersededById: renewal.id })
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: renewal.id } })).toMatchObject({ status: 'COMPLETED', completedOn: new Date('2026-12-20'), validUntil: new Date('2027-12-20'), remindOn: new Date('2027-11-20') })
    const reviews = await prisma.riskReview.findMany({ where: { supplierId: s.supplierId }, orderBy: { createdAt: 'asc' } })
    expect(reviews.map((r) => [r.reason, r.status, r.completedByAssessmentId])).toEqual([
      ['SCHEDULED', 'DONE', renewal.id],
      ['STATUS_CHANGED', 'DONE', renewal.id],
    ])
    expect(reviews.map((r) => r.id)).toContain(flagged.reviewId)
    expect(await supplierOf(s.supplierId)).toMatchObject({ riskStatus: 'CURRENT', riskTier: 'HIGH', currentRiskAssessmentId: renewal.id, riskValidUntil: new Date('2027-12-20') })
    // the tier did not change: no risk_tier_changed for the renewal
    expect((await eventsOf(s.supplierId, 'supplier.risk_tier_changed')).map((e) => (e.data as { assessmentId: string }).assessmentId)).not.toContain(renewal.id)
    // the next round: nothing until its own remindOn
    await daily('2027-11-19')
    expect(await prisma.riskReview.count({ where: { supplierId: s.supplierId, status: 'OPEN' } })).toBe(0)
    await daily('2027-11-20')
    expect(await prisma.riskReview.findFirstOrThrow({ where: { supplierId: s.supplierId, status: 'OPEN' } })).toMatchObject({ reason: 'SCHEDULED', sourceAssessmentId: renewal.id })
  })
})

describe('[FR-RSK-205/AC2] the review of S11-09: a late run, a supplier back to ACTIVE, the state written by the old rule', () => {
  let o: DoaOrg
  beforeAll(async () => {
    o = await createP2Org()
    await riskOrg(o)
  })

  it('the first run after validUntil (days missed): the review, OVERDUE, risk_review.overdue and the notice that POs are blocked', async () => {
    const s = await supplierWithContact('RR-LATE', o)
    await assessedAt(s, COMPLETED_AT, o)
    const run = await daily('2026-12-16', o)
    expect(run.reviewsScheduled).toBe(1)
    const review = await prisma.riskReview.findFirstOrThrow({ where: { supplierId: s.supplierId } })
    expect(review).toMatchObject({ reason: 'SCHEDULED', status: 'OPEN' })
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('OVERDUE')
    expect(await eventsOf(review.id, 'risk_review.overdue')).toHaveLength(1)
    const told = await prisma.notification.findMany({ where: { subjectId: s.supplierId, templateKey: 'risk.status_changed' } })
    expect(told.length).toBeGreaterThan(0)
    expect(told.every((n) => n.urgency === 'DIGEST' && (n.data as { blocks?: boolean }).blocks === true)).toBe(true)
  })

  it('a supplier made INACTIVE has its review cancelled; ACTIVE again, the job opens a new one; replays count nothing', async () => {
    const s = await supplierWithContact('RR-BACK', o)
    await assessedAt(s, COMPLETED_AT, o)
    expect((await daily('2026-11-15', o)).reviewsScheduled).toBe(1)
    await prisma.supplier.update({ where: { id: s.supplierId }, data: { status: 'INACTIVE' } })
    await daily('2026-11-16', o)
    expect(await prisma.riskReview.findFirstOrThrow({ where: { supplierId: s.supplierId } })).toMatchObject({ status: 'CANCELLED', cancelReason: 'SUPPLIER_INACTIVE' })
    await prisma.supplier.update({ where: { id: s.supplierId }, data: { status: 'ACTIVE' } })
    expect((await daily('2026-11-17', o)).reviewsScheduled).toBe(1)
    expect(await prisma.riskReview.findMany({ where: { supplierId: s.supplierId }, select: { status: true }, orderBy: { createdAt: 'asc' } })).toEqual([{ status: 'CANCELLED' }, { status: 'OPEN' }])
    // the assessment the first review opened is still the one to answer: no second assessment
    expect(await prisma.riskAssessment.count({ where: { supplierId: s.supplierId, status: 'DRAFT' } })).toBe(1)
    // the next days: nothing scheduled again, nothing counted
    expect((await daily('2026-11-18', o)).reviewsScheduled).toBe(0)
    expect((await daily('2026-11-18', o)).reviewsScheduled).toBe(0)
  })

  it('a review a person cancelled is not opened again for the same assessment', async () => {
    const s = await supplierWithContact('RR-CXL', o)
    await assessedAt(s, COMPLETED_AT, o)
    await daily('2026-11-15', o)
    await prisma.riskReview.updateMany({ where: { supplierId: s.supplierId }, data: { status: 'CANCELLED', cancelReason: 'จัดซื้อยกเลิก' } })
    await daily('2026-11-16', o)
    expect(await prisma.riskReview.count({ where: { supplierId: s.supplierId } })).toBe(1)
  })

  it('IN_PROGRESS written by the rule before S11-09 for an assessed supplier is corrected to the state of the day', async () => {
    const s = await supplierWithContact('RR-OLD', o)
    await assessedAt(s, COMPLETED_AT, o)
    await prisma.supplier.update({ where: { id: s.supplierId }, data: { riskStatus: 'IN_PROGRESS' } })
    expect((await daily('2026-11-10', o)).suppliersRefreshed).toBeGreaterThanOrEqual(1)
    expect((await supplierOf(s.supplierId)).riskStatus).toBe('CURRENT')
  })

  it('an override that lapses while an assessment is open: the review links to it, the event opens none', async () => {
    const s = await supplierWithContact('RR-OPEN', o)
    const opened = ok(await openRiskAssessment(o.ctxOf('proc_officer', morning('2026-11-02')), { supplierId: s.supplierId, screening: SCREEN_HIGH }, key()))
    const row = await prisma.riskOverride.create({
      data: { organizationId: o.organizationId, number: 'RO-OPEN', supplierId: s.supplierId, reason: 'งานด่วน', capGrossSatang: 1_000_000n, expiresOn: new Date('2026-11-05'), requestedById: o.member.proc_officer!, submittedAt: COMPLETED_AT, decidedAt: COMPLETED_AT, status: 'APPROVED' },
    })
    await daily('2026-11-06', o)
    const review = await prisma.riskReview.findFirstOrThrow({ where: { supplierId: s.supplierId, reason: 'OVERRIDE_EXPIRED' } })
    expect(review.sourceOverrideId).toBe(row.id)
    expect((await eventsOf(review.id, 'risk_review.scheduled'))[0]).toMatchObject({ data: { openedAssessmentId: null } })
    const notice = await prisma.notification.findFirstOrThrow({ where: { subjectId: s.supplierId, templateKey: 'risk.review_due' } })
    expect(notice.data).toMatchObject({ reason: 'OVERRIDE_EXPIRED', assessmentId: opened.assessmentId })
  })
})
