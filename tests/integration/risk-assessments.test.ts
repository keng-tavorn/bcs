import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '@/server/db/client'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalRiskAssessment } from '@/server/portal/queries-risk'
import { portalCtx } from '@/server/portal/session'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import {
  answerRiskAssessment,
  cancelRiskAssessment,
  fillRiskAssessmentOnBehalf,
  openRiskAssessment,
  riskAssessmentView,
  riskEvidenceScanned,
  submitRiskAssessment,
  uploadRiskEvidence,
} from '@/server/services/risk'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'
import { p2p } from '../support/p2p'

// S11-05 (FR-RSK-201 AC1 AC2 AC3 AC5 AC6 · FR-RSK-204 AC4 · BR-RSK-05 BR-RSK-06 BR-RSK-14 BR-RSK-17 BR-RSK-18 · INV-RSK-02
// INV-RSK-05 · INV-SUP-05): risk assessments against Postgres and the real bucket — opened from a PO or the supplier's
// page, filled from a verified certificate, answered in the portal or by procurement for the supplier, sent, completed
// with no reviewer rule (S11-06 adds the rules), and the files behind an answer through S7's scan. The tiers, the policy
// and the questions are test data of the organization (the demo values of OQ-221 OQ-222), never code.

const NOW = new Date('2026-11-09T03:00:00Z')
const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const PDF = (text = 'hello') => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF`)
let org: DoaOrg
const as = (code: string, now = NOW) => org.ctxOf(code, now)
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

const yn = (no: number, extra: Record<string, unknown> = {}) => [
  { code: 'Y', labelTh: 'ใช่', labelEn: 'Yes', points: 0, ...extra },
  { code: 'N', labelTh: 'ไม่ใช่', labelEn: 'No', points: no },
]
const QUESTIONS = [
  { code: 'RQ-GEN-01', domain: 'GENERAL' as const, options: yn(25), sortOrder: 10 },
  { code: 'RQ-PRV-01', domain: 'PRIVACY' as const, options: yn(20), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 20 },
  { code: 'RQ-IS-01', domain: 'INFOSEC' as const, options: [{ code: 'Y', labelTh: 'มี', labelEn: 'Yes', points: 0, evidence: true }, { code: 'N', labelTh: 'ไม่มี', labelEn: 'No', points: 12 }], appliesWhen: { field: 'accessesSystems', op: 'eq', value: 'Y' }, evidenceScopeRequired: true, evidenceScope: 'ISO 27001', sortOrder: 30 },
]
const SCREEN = { processesPersonalData: 'N' as const, accessesSystems: 'Y' as const, accessesPremises: 'N' as const }

async function riskOrg(o: DoaOrg, options: { questionnaire?: boolean } = {}) {
  const id = o.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: new Date('2026-01-01T00:00:00+07:00'), contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({ data: [{ organizationId: id, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: NOW }, { organizationId: id, memberId: o.member.auditor!, role: 'AUDITOR', grantedAt: NOW }] })
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
  if (options.questionnaire !== false) {
    const q = await prisma.riskQuestionnaire.create({ data: { organizationId: id, code: 'RQ-T', versionNo: 1, status: 'PUBLISHED', effectiveFrom: new Date('2026-11-01T00:00:00+07:00'), submittedById: o.member.admin!, submittedAt: NOW, publishedById: o.member.admin2!, publishedAt: NOW, checksum: 'test' } })
    for (const question of QUESTIONS) await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, textTh: question.code, textEn: question.code, ...question } })
  }
  await prisma.supplierDocumentType.create({ data: { organizationId: id, code: 'ISO_CERT', nameTh: 'ใบรับรอง ISO', nameEn: 'ISO certificate', appliesTo: ['JURISTIC'], singleInstance: false, linkedRiskQuestionCodes: ['RQ-IS-01'] } })
}

async function supplierWithContact(code: string) {
  const supplier = await prisma.supplier.create({ data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: true, portalEnabled: true, email: `${code.toLowerCase()}@supplier.test` } })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: supplier.id, nameTh: `ผู้ติดต่อ ${code}`, email: `c-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  return { supplierId: supplier.id, contact, portal: (now = NOW) => portalCtx(org.organizationId, contact, now) }
}

async function verifiedIso(supplierId: string, scope: string, expiresOn = new Date('2027-06-30')) {
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `test/${randomUUID()}.pdf`, fileName: 'iso.pdf', mimeType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', uploadedById: org.member.proc_officer!, scanStatus: 'CLEAN' } })
  return prisma.supplierDocument.create({
    data: { organizationId: org.organizationId, supplierId, documentTypeCode: 'ISO_CERT', fileId: file.id, scope, scopeKey: scope.toLowerCase(), issuedOn: new Date('2026-01-01'), expiresOn, status: 'VERIFIED', verifiedById: org.member.proc_officer!, verifiedAt: NOW },
  })
}

const version = async (id: string) => (await prisma.riskAssessment.findUniqueOrThrow({ where: { id } })).version

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await riskOrg(org)
})

describe('[FR-RSK-201/AC1] the question set comes from the screening of the work', () => {
  it('opened from a PO: the requests of its lines are read, a Y in any of them is Y, the line categories are kept', async () => {
    const s = await supplierWithContact('RA-PO')
    const flow = p2p(org, NOW)
    const line = await flow.fundedLine(1_000_000n)
    const first = await flow.approvedRequest(line, [{ quantity: '1', unitPrice: '1000.00' }])
    const second = await flow.approvedRequest(line, [{ quantity: '1', unitPrice: '2000.00' }])
    await prisma.request.update({ where: { id: first.id }, data: { formData: { processesPersonalData: 'N', accessesSystems: 'Y', accessesPremises: 'N' } } })
    await prisma.request.update({ where: { id: second.id }, data: { formData: { processesPersonalData: 'Y', accessesSystems: 'N', accessesPremises: 'N' } } })
    const po = await flow.approvedPo([first.lines[0]!.id, second.lines[0]!.id], s.supplierId)
    await prisma.poLine.updateMany({ where: { poId: po.id }, data: { categoryCode: 'IT' } })
    const opened = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, poId: po.id }, key()))
    expect(opened).toMatchObject({ inherentTier: 'HIGH', questions: 3 })
    expect(opened.number).toMatch(/^RSA-\d{4}-\d{5}$/)
    const row = await prisma.riskAssessment.findUniqueOrThrow({ where: { id: opened.assessmentId } })
    expect(row).toMatchObject({ screening: { processesPersonalData: 'Y', accessesSystems: 'Y', accessesPremises: 'N' }, categoryCodes: ['IT'], triggerPoId: po.id, status: 'DRAFT' })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: s.supplierId } })).toMatchObject({ riskStatus: 'IN_PROGRESS', riskTier: null })
  })

  it('from the supplier page without the three answers → SCREENING_REQUIRED; a second open → RISK_ASSESSMENT_OPEN', async () => {
    const s = await supplierWithContact('RA-SCR')
    expect(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId }, key())).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: 'SCREENING_REQUIRED' } } })
    ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    expect(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key())).toMatchObject({ ok: false, error: { code: 'RISK_ASSESSMENT_OPEN' } })
  })

  it('no version in effect → RISK_QUESTIONNAIRE_NOT_PUBLISHED; RISK off → MODULE_DISABLED; FINANCE may not open (deny)', async () => {
    const bare = await createP2Org()
    await riskOrg(bare, { questionnaire: false })
    const sup = await prisma.supplier.create({ data: { organizationId: bare.organizationId, code: 'RA-NOQ', nameTh: 'ไม่มีแบบ', isForeign: true } })
    expect(await openRiskAssessment(bare.ctxOf('proc_officer', NOW), { supplierId: sup.id, screening: SCREEN }, key())).toMatchObject({ ok: false, error: { code: 'RISK_QUESTIONNAIRE_NOT_PUBLISHED' } })
    const off = await createP2Org()
    const offSup = await prisma.supplier.create({ data: { organizationId: off.organizationId, code: 'RA-OFF', nameTh: 'ปิด', isForeign: true } })
    expect(await openRiskAssessment(off.ctxOf('proc_officer', NOW), { supplierId: offSup.id, screening: SCREEN }, key())).toMatchObject({ ok: false, error: { code: 'MODULE_DISABLED' } })
    const s = await supplierWithContact('RA-FIN')
    expect(await openRiskAssessment(as('fin_officer'), { supplierId: s.supplierId, screening: SCREEN }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-RSK-201/AC2] [BR-RSK-05] a verified certificate answers its question; it is confirmed, never changed, and revoked when it no longer holds', () => {
  it('fills RQ-IS-01 from an ISO 27001 of the work scope; another scope does not', async () => {
    const s = await supplierWithContact('RA-EV')
    await verifiedIso(s.supplierId, 'ISO 9001')
    const doc = await verifiedIso(s.supplierId, 'ISO 27001')
    const opened = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN, workScopes: ['ISO 27001'] }, key()))
    const answers = await prisma.riskAnswer.findMany({ where: { assessmentId: opened.assessmentId } })
    expect(answers).toEqual([expect.objectContaining({ questionCode: 'RQ-IS-01', optionCode: 'Y', source: 'EVIDENCE', evidenceDocumentId: doc.id, points: 0 })])
    // changing it by hand is refused; confirming it makes it the supplier's own and keeps the document
    expect(await answerRiskAssessment(s.portal(), { assessmentId: opened.assessmentId, expectedVersion: await version(opened.assessmentId), answers: [{ questionCode: 'RQ-IS-01', optionCode: 'N' }] }, key())).toMatchObject({ ok: false, error: { details: { reason: 'EVIDENCE_LOCKED' } } })
    ok(await answerRiskAssessment(s.portal(), { assessmentId: opened.assessmentId, expectedVersion: await version(opened.assessmentId), answers: [{ questionCode: 'RQ-IS-01', optionCode: 'Y', confirmEvidence: true }] }, key()))
    expect(await prisma.riskAnswer.findFirstOrThrow({ where: { assessmentId: opened.assessmentId, questionCode: 'RQ-IS-01' } })).toMatchObject({ source: 'EXPLICIT', evidenceDocumentId: doc.id, answeredByContactId: s.contact.id })
    // the certificate expires before the send: the confirmed answer is cleared on the next save (GC-RSK-23)
    await prisma.supplierDocument.update({ where: { id: doc.id }, data: { expiresOn: new Date('2026-11-08') } })
    ok(await answerRiskAssessment(s.portal(), { assessmentId: opened.assessmentId, expectedVersion: await version(opened.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key()))
    expect(await prisma.riskAnswer.findFirst({ where: { assessmentId: opened.assessmentId, questionCode: 'RQ-IS-01' } })).toBeNull()
    expect(await prisma.event.findFirst({ where: { aggregateId: opened.assessmentId, type: 'risk_assessment.answered', data: { path: ['source'], equals: 'EVIDENCE_REVOKED' } } })).toMatchObject({ data: { questionCodes: ['RQ-IS-01'] } })
  })
})

describe('[FR-RSK-201/AC3] [BR-RSK-06] a HIGH supplier answers every question itself', () => {
  it('a HIGH assessment with an answer from evidence is refused RISK_ANSWERS_INCOMPLETE naming it; MEDIUM takes evidence', async () => {
    const high = await supplierWithContact('RA-HI')
    await verifiedIso(high.supplierId, 'ISO 27001')
    const h = ok(await openRiskAssessment(as('proc_officer'), { supplierId: high.supplierId, screening: { ...SCREEN, processesPersonalData: 'Y' }, workScopes: ['ISO 27001'] }, key()))
    ok(await answerRiskAssessment(high.portal(), { assessmentId: h.assessmentId, expectedVersion: await version(h.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }, { questionCode: 'RQ-PRV-01', optionCode: 'Y' }] }, key()))
    expect(await submitRiskAssessment(high.portal(), { assessmentId: h.assessmentId, expectedVersion: await version(h.assessmentId) }, key())).toMatchObject({ ok: false, error: { code: 'RISK_ANSWERS_INCOMPLETE', details: { missing: ['RQ-IS-01'], tier: 'HIGH' } } })
    expect((await prisma.riskAssessment.findUniqueOrThrow({ where: { id: h.assessmentId } })).status).toBe('DRAFT')

    const medium = await supplierWithContact('RA-MED')
    await verifiedIso(medium.supplierId, 'ISO 27001')
    const m = ok(await openRiskAssessment(as('proc_officer'), { supplierId: medium.supplierId, screening: SCREEN, workScopes: ['ISO 27001'] }, key()))
    expect(await submitRiskAssessment(medium.portal(), { assessmentId: m.assessmentId, expectedVersion: await version(m.assessmentId) }, key())).toMatchObject({ ok: false, error: { code: 'RISK_ANSWERS_INCOMPLETE', details: { missing: ['RQ-GEN-01'] } } })
    ok(await answerRiskAssessment(medium.portal(), { assessmentId: m.assessmentId, expectedVersion: await version(m.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key()))
    expect(ok(await submitRiskAssessment(medium.portal(), { assessmentId: m.assessmentId, expectedVersion: await version(m.assessmentId) }, key()))).toEqual({ status: 'COMPLETED', points: 0, tier: 'MEDIUM' })
  })
})

describe('[FR-RSK-201/AC5] [BR-RSK-17] [INV-SUP-05] the contact answers in the portal; procurement may fill in for it', () => {
  it('the contact\'s commands are SUPPLIER events on PORTAL; procurement\'s are ON_BEHALF with filledOnBehalfById', async () => {
    const s = await supplierWithContact('RA-PORT')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    ok(await answerRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'N', note: 'อยู่ระหว่างจัดทำ' }] }, key()))
    const event = await prisma.event.findFirstOrThrow({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.answered' }, orderBy: { seq: 'desc' } })
    expect(event).toMatchObject({ actorType: 'SUPPLIER', actorSupplierContactId: s.contact.id, actorMemberId: null, channel: 'PORTAL', data: { source: 'EXPLICIT', onBehalf: false } })
    ok(await fillRiskAssessmentOnBehalf(as('proc_officer'), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-IS-01', optionCode: 'N' }] }, key()))
    expect(await prisma.riskAnswer.findFirstOrThrow({ where: { assessmentId: a.assessmentId, questionCode: 'RQ-IS-01' } })).toMatchObject({ source: 'ON_BEHALF', answeredByMemberId: org.member.proc_officer })
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ filledOnBehalfById: org.member.proc_officer })
    // procurement does not answer as the contact, nor the contact as procurement
    expect(await answerRiskAssessment(as('proc_officer'), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const done = ok(await submitRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId) }, key()))
    expect(done).toEqual({ status: 'COMPLETED', points: 37, tier: 'MEDIUM' })
    // once sent, the portal reads it and answers nothing more
    expect(await answerRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key())).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('[INV-RSK-05] the contact of another supplier sees and answers nothing of it', async () => {
    const mine = await supplierWithContact('RA-MINE')
    const other = await supplierWithContact('RA-OTHER')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: mine.supplierId, screening: SCREEN }, key()))
    expect(await portalRiskAssessment(other.portal(), a.assessmentId)).toBeNull()
    expect(await portalRiskAssessment(mine.portal(), a.assessmentId)).toMatchObject({ id: a.assessmentId, status: 'DRAFT' })
    expect(await answerRiskAssessment(other.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key())).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    expect(await uploadRiskEvidence(other.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: 'x.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false })
  })
})

describe('[FR-RSK-201/AC6] [INV-RSK-02] one open assessment, one current; a send counts once', () => {
  it('two sends at once: one completes, the other is refused; the same key answers the same; a new one supersedes the old', async () => {
    const s = await supplierWithContact('RA-TWICE')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    ok(await answerRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }, { questionCode: 'RQ-IS-01', optionCode: 'Y' }] }, key()))
    const v = await version(a.assessmentId)
    const same = key()
    const [one, two] = await Promise.all([submitRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: v }, key()), submitRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: v }, key())])
    expect([one.ok, two.ok].filter(Boolean)).toHaveLength(1)
    expect(await prisma.event.count({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.completed' } })).toBe(1)
    const first = await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })
    expect(first).toMatchObject({ status: 'COMPLETED', tier: 'MEDIUM', pointsTotal: 0, completedOn: new Date('2026-11-09'), validUntil: new Date('2028-11-09'), remindOn: new Date('2028-10-10') })
    expect(first.scoringSnapshot).toMatchObject({ screeningTierMap: { accessesSystems: 'MEDIUM' }, tiers: expect.arrayContaining([expect.objectContaining({ code: 'HIGH', minPoints: 40 })]) })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: s.supplierId } })).toMatchObject({ riskTier: 'MEDIUM', riskStatus: 'CURRENT', currentRiskAssessmentId: a.assessmentId })
    // a reassessment that completes supersedes the first (INV-RSK-02: one COMPLETED)
    const later = new Date('2026-12-01T03:00:00Z')
    const b = ok(await openRiskAssessment(as('proc_officer', later), { supplierId: s.supplierId, screening: SCREEN }, key()))
    ok(await answerRiskAssessment(s.portal(later), { assessmentId: b.assessmentId, expectedVersion: await version(b.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'N' }, { questionCode: 'RQ-IS-01', optionCode: 'N' }] }, key()))
    const firstTry = await submitRiskAssessment(s.portal(later), { assessmentId: b.assessmentId, expectedVersion: await version(b.assessmentId) }, same)
    expect(ok(firstTry)).toEqual({ status: 'COMPLETED', points: 37, tier: 'MEDIUM' })
    // the same request again (a double click) answers the same and changes nothing
    expect(await submitRiskAssessment(s.portal(later), { assessmentId: b.assessmentId, expectedVersion: (await version(b.assessmentId)) - 1 }, same)).toEqual(firstTry)
    expect(await prisma.riskAssessment.findUniqueOrThrow({ where: { id: a.assessmentId } })).toMatchObject({ status: 'SUPERSEDED', supersededById: b.assessmentId })
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: s.supplierId } })).toMatchObject({ currentRiskAssessmentId: b.assessmentId })
  })

  it('procurement cancels an open assessment with its reason; the supplier is NOT_ASSESSED again', async () => {
    const s = await supplierWithContact('RA-CXL')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    expect(await cancelRiskAssessment(s.portal() as never, { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), reason: 'x' }, key())).toMatchObject({ ok: false })
    ok(await cancelRiskAssessment(as('proc_officer'), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), reason: 'เปลี่ยนผู้ขาย' }, key()))
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: s.supplierId } })).toMatchObject({ riskStatus: 'NOT_ASSESSED' })
  })

  it('the risk file reads for FINANCE and AUDITOR, not for a requester (deny)', async () => {
    const s = await supplierWithContact('RA-VIEW')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    expect(ok(await riskAssessmentView(as('auditor'), a.assessmentId))).toMatchObject({ id: a.assessmentId, canManage: false, questions: expect.arrayContaining([expect.objectContaining({ code: 'RQ-IS-01' })]) })
    expect(ok(await riskAssessmentView(as('proc_officer'), a.assessmentId))).toMatchObject({ canManage: true })
    expect(await riskAssessmentView(as('req_con'), a.assessmentId)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })
})

describe('[FR-RSK-204/AC4] [BR-RSK-18] the files behind an answer', () => {
  it('a PDF behind an answered question, at most five; an infected one loses its link, the file and the answer stay', async () => {
    const s = await supplierWithContact('RA-FILE')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    expect(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: 'policy.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { details: { reason: 'ANSWER_FIRST' } } })
    ok(await answerRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key()))
    expect(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: 'x.exe', bytes: new TextEncoder().encode('MZ...') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TYPE_NOT_ALLOWED' } } })
    const first = ok(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: 'policy.pdf', bytes: PDF('one'), aiReadable: true }, key()))
    expect(await prisma.fileLink.findFirstOrThrow({ where: { fileId: first.fileId } })).toMatchObject({ kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: first.answerId })
    expect(await prisma.fileObject.findUniqueOrThrow({ where: { id: first.fileId } })).toMatchObject({ scanStatus: 'PENDING', mimeType: 'application/pdf' })
    expect(await prisma.riskAnswer.findUniqueOrThrow({ where: { id: first.answerId } })).toMatchObject({ evidenceAiReadable: true })
    expect(await prisma.event.findFirst({ where: { aggregateId: first.fileId, type: 'file.uploaded' } })).not.toBeNull()
    for (let i = 0; i < 4; i++) ok(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: `p${i}.pdf`, bytes: PDF(`n${i}`) }, key()))
    expect(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: 'p6.pdf', bytes: PDF('six') }, key())).toMatchObject({ ok: false, error: { details: { reason: 'TOO_MANY_FILES' } } })
    // the scan of S7 says INFECTED: the link goes, the file stays for the audit, the supplier is told
    await prisma.fileObject.update({ where: { id: first.fileId }, data: { scanStatus: 'INFECTED' } })
    expect(await riskEvidenceScanned(org.organizationId, first.fileId, 'INFECTED', NOW)).toBe('REJECTED')
    expect(await prisma.fileLink.findFirst({ where: { fileId: first.fileId } })).toBeNull()
    expect(await prisma.fileObject.findUnique({ where: { id: first.fileId } })).not.toBeNull()
    expect(await prisma.riskAnswer.findUnique({ where: { id: first.answerId } })).not.toBeNull()
    expect(await prisma.event.findFirst({ where: { aggregateId: a.assessmentId, type: 'risk_assessment.evidence_rejected' } })).toMatchObject({ data: { questionCode: 'RQ-GEN-01', fileId: first.fileId } })
    expect(await prisma.supplierNotice.findFirst({ where: { subjectId: a.assessmentId, templateKey: 'supplier.risk_evidence_rejected' } })).not.toBeNull()
    // the job again (a retry): the same answer, nothing told twice
    expect(await riskEvidenceScanned(org.organizationId, first.fileId, 'INFECTED', NOW)).toBe('REJECTED')
    expect(await prisma.supplierNotice.count({ where: { subjectId: a.assessmentId, templateKey: 'supplier.risk_evidence_rejected' } })).toBe(1)
  })

  it('a contact who has not accepted the current privacy notice uploads nothing', async () => {
    const s = await supplierWithContact('RA-PRIV')
    const a = ok(await openRiskAssessment(as('proc_officer'), { supplierId: s.supplierId, screening: SCREEN }, key()))
    ok(await answerRiskAssessment(s.portal(), { assessmentId: a.assessmentId, expectedVersion: await version(a.assessmentId), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }] }, key()))
    await prisma.supplierContact.update({ where: { id: s.contact.id }, data: { privacyNoticeVersion: '2000-01-01' } })
    expect(await uploadRiskEvidence(s.portal(), { assessmentId: a.assessmentId, questionCode: 'RQ-GEN-01', fileName: 'p.pdf', bytes: PDF() }, key())).toMatchObject({ ok: false, error: { code: 'PRIVACY_NOTICE_OUTDATED' } })
  })
})
