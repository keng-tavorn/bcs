import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { beforeAll, describe, expect, it } from 'vitest'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { prisma } from '@/server/db/client'
import { forTenant } from '@/server/db/tenant'
import { setDefaultOutboxSender } from '@/server/events/outbox'
import { portalCtx } from '@/server/portal/session'
import { answerRiskAssessment, exportSupplierRiskFile, openRiskAssessment, riskFileWorkbook, riskOverview, runRiskReviewDaily, submitRiskAssessment, supplierRiskBadges, supplierRiskFile, supplierRiskProvider, supplierRiskStatus } from '@/server/services/risk'
import type { DoaOrg } from '../support/doa-org'
import { createP2Org } from '../support/p2-org'

// S11-10 (FR-RSK-204 AC1 AC3 and the keeping of AC4 · BR-RSK-14 BR-RSK-18 BR-RSK-20 · OQ-230) against Postgres: the
// supplier's risk file and its Excel copy, supplierRiskStatus for S10 and the other pages, the overview of /risk, and
// the evidence files purged by risk-review-daily once past risk.answerRetentionYears. The tiers, the policy and the
// questions are test data of the organization (the demo values of OQ-221 OQ-222 OQ-226).

const key = () => ({ idempotencyKey: randomUUID(), sender: null })
const COMPLETED_AT = new Date('2025-12-15T03:00:00Z')
const NOW = new Date('2026-11-20T03:00:00Z')
const at = new Date('2025-01-01T00:00:00+07:00')
let org: DoaOrg
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const yn = (no: number) => [
  { code: 'Y', labelTh: 'ใช่', labelEn: 'Yes', points: 0 },
  { code: 'N', labelTh: 'ไม่ใช่', labelEn: 'No', points: no },
]
const SCREEN_HIGH = { processesPersonalData: 'Y' as const, accessesSystems: 'N' as const, accessesPremises: 'N' as const }

async function riskOrg(o: DoaOrg) {
  const id = o.organizationId
  await prisma.orgModule.create({ data: { organizationId: id, module: 'RISK', enabled: true, enabledAt: at, contractRef: 'TEST-P2', reason: 'องค์กรทดสอบระยะ 2' } })
  await prisma.roleAssignment.createMany({
    data: [
      { organizationId: id, memberId: o.member.admin!, role: 'ORG_ADMIN', grantedAt: at },
      { organizationId: id, memberId: o.member.fin_officer!, role: 'FINANCE', grantedAt: at },
      { organizationId: id, memberId: o.member.auditor!, role: 'AUDITOR', grantedAt: at },
      { organizationId: id, memberId: o.member.ceo!, role: 'EXECUTIVE', grantedAt: at },
    ],
  })
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
  for (const question of [
    { code: 'RQ-GEN-01', domain: 'GENERAL' as const, options: yn(25), sortOrder: 10 },
    { code: 'RQ-PRV-01', domain: 'PRIVACY' as const, options: yn(20), appliesWhen: { field: 'processesPersonalData', op: 'eq', value: 'Y' }, sortOrder: 20 },
  ]) {
    await prisma.riskQuestion.create({ data: { organizationId: id, questionnaireId: q.id, textTh: question.code, textEn: question.code, ...question } })
  }
}

/** A supplier with a portal contact; an individual Thai one (tax id not starting with 0) when `taxId` is given */
async function supplierWithContact(code: string, taxId?: string) {
  const supplier = await prisma.supplier.create({
    data: { organizationId: org.organizationId, code, nameTh: `ผู้ขาย ${code}`, isForeign: !taxId, taxId: taxId ?? null, portalEnabled: true, email: `${code.toLowerCase()}@supplier.test` },
  })
  const contact = await prisma.supplierContact.create({ data: { organizationId: org.organizationId, supplierId: supplier.id, nameTh: `ผู้ติดต่อ ${code}`, email: `c-${randomUUID().slice(0, 6)}@supplier.test`, isPrimary: true, privacyNoticeVersion: PORTAL_PRIVACY_NOTICE_VERSION } })
  return { supplierId: supplier.id, portal: (now: Date) => portalCtx(org.organizationId, contact, now) }
}
const version = async (id: string) => (await prisma.riskAssessment.findUniqueOrThrow({ where: { id } })).version

/** A HIGH assessment answered by the contact and COMPLETED at `when` (no reviewer rule in this organization) */
async function assessedAt(s: Awaited<ReturnType<typeof supplierWithContact>>, when: Date) {
  const opened = ok(await openRiskAssessment(org.ctxOf('proc_officer', when), { supplierId: s.supplierId, screening: SCREEN_HIGH, categoryCodes: ['SEC'], workScopes: [] }, key()))
  const id = opened.assessmentId
  ok(await answerRiskAssessment(s.portal(when), { assessmentId: id, expectedVersion: await version(id), answers: [{ questionCode: 'RQ-GEN-01', optionCode: 'Y' }, { questionCode: 'RQ-PRV-01', optionCode: 'N' }] }, key()))
  expect(ok(await submitRiskAssessment(s.portal(when), { assessmentId: id, expectedVersion: await version(id) }, key()))).toMatchObject({ status: 'COMPLETED' })
  return id
}

/** A file behind an answer, as S11-05's upload leaves it once the scan called it clean */
async function evidenceFile(assessmentId: string, questionCode: string) {
  const answer = await prisma.riskAnswer.findFirstOrThrow({ where: { assessmentId, questionCode } })
  const file = await prisma.fileObject.create({ data: { organizationId: org.organizationId, storageKey: `${org.organizationId}/risk-evidence/${randomUUID()}.pdf`, fileName: 'policy.pdf', mimeType: 'application/pdf', sizeBytes: 10, status: 'AVAILABLE', scanStatus: 'CLEAN' } })
  await prisma.fileLink.create({ data: { organizationId: org.organizationId, fileId: file.id, subjectType: 'RiskAnswer', subjectId: answer.id, kind: 'RISK_EVIDENCE' } })
  return file.id
}

let main: Awaited<ReturnType<typeof supplierWithContact>>
let mainAssessment: string
let person: Awaited<ReturnType<typeof supplierWithContact>>

beforeAll(async () => {
  setDefaultOutboxSender(null)
  org = await createP2Org()
  await riskOrg(org)
  main = await supplierWithContact('RF-01')
  mainAssessment = await assessedAt(main, COMPLETED_AT)
  await prisma.riskOverride.create({
    data: { organizationId: org.organizationId, number: 'RO-T-00001', supplierId: main.supplierId, reason: 'งานด่วน', capGrossSatang: 12_000_000n, usedGrossSatang: 0n, expiresOn: new Date('2026-11-25'), requestedById: org.member.proc_officer!, submittedAt: COMPLETED_AT, decidedAt: COMPLETED_AT, status: 'APPROVED' },
  })
  person = await supplierWithContact('RF-02', '3101700123456')
  await assessedAt(person, COMPLETED_AT)
})

describe('[FR-RSK-204/AC1] the supplier risk file (BR-RSK-14)', () => {
  it('every assessment with its answers and their source, the files as metadata, the overrides, the reassessments and the timeline', async () => {
    const fileId = await evidenceFile(mainAssessment, 'RQ-GEN-01')
    const file = ok(await supplierRiskFile(org.ctxOf('proc_officer', NOW), main.supplierId))
    expect(file.supplier).toMatchObject({ code: 'RF-01', individual: false, taxIdMasked: false })
    expect(file.status).toMatchObject({ tier: 'HIGH', status: 'CURRENT', validUntil: '2026-12-15', currentAssessmentId: mainAssessment, openOverrideId: null })
    expect(file.assessments).toHaveLength(1)
    expect(file.assessments[0]).toMatchObject({ id: mainAssessment, status: 'COMPLETED', tier: 'HIGH', completedOn: '2025-12-15', validUntil: '2026-12-15' })
    expect(file.assessments[0]!.answers.map((a) => [a.questionCode, a.optionCode, a.source, a.aiConfirmed])).toEqual([
      ['RQ-GEN-01', 'Y', 'EXPLICIT', false],
      ['RQ-PRV-01', 'N', 'EXPLICIT', false],
    ])
    expect(file.files).toEqual([expect.objectContaining({ fileId, fileName: 'policy.pdf', scanStatus: 'CLEAN', questionCode: 'RQ-GEN-01' })])
    expect(file.overrides).toEqual([expect.objectContaining({ number: 'RO-T-00001', status: 'APPROVED', forPo: null, capGrossSatang: 12_000_000n, expiresOn: '2026-11-25', usedBy: [] })])
    expect(file.timeline.map((e) => e.type)).toEqual(expect.arrayContaining(['risk_assessment.opened', 'risk_assessment.completed', 'supplier.risk_status_changed']))
    expect(file.canManage).toBe(true)
  })

  it('FINANCE EXECUTIVE AUDITOR read it, only PROCUREMENT may open an assessment from it', async () => {
    for (const reader of ['fin_officer', 'ceo', 'auditor']) {
      const file = ok(await supplierRiskFile(org.ctxOf(reader, NOW), main.supplierId))
      expect(file.assessments).toHaveLength(1)
      expect(file.canManage).toBe(false)
    }
  })

  it('a requester is refused (deny), and so is a supplier of another organization or RISK switched off', async () => {
    const refused = await supplierRiskFile(org.ctxOf('req_con', NOW), main.supplierId)
    expect(refused.ok ? null : refused.error.code).toBe('FORBIDDEN')
    const other = await createP2Org()
    const missing = await supplierRiskFile(org.ctxOf('proc_officer', NOW), randomUUID())
    expect(missing.ok ? null : missing.error.code).toBe('NOT_FOUND')
    const off = await supplierRiskFile(other.ctxOf('proc_officer', NOW), main.supplierId)
    expect(off.ok ? null : off.error.code).toBe('MODULE_DISABLED')
  })

  it("an individual supplier's tax id is masked for every reader (BR-RSK-14 BR-RSK-20)", async () => {
    for (const reader of ['proc_officer', 'fin_officer']) {
      const file = ok(await supplierRiskFile(org.ctxOf(reader, NOW), person.supplierId))
      expect(file.supplier).toMatchObject({ individual: true, taxId: 'XXXXXXXXX3456', taxIdMasked: true })
    }
  })
})

describe('[FR-RSK-204/AC3] the risk file as Excel by a POST (export.generated · file.downloaded)', () => {
  it('PROCUREMENT exports: the ExportJob with its sha256, both events, and a five-minute link', async () => {
    const r = ok(await exportSupplierRiskFile(org.ctxOf('proc_officer', NOW), { supplierId: main.supplierId }, key()))
    expect(r.url).toMatch(/^https?:\/\//)
    expect(r.expiresInSeconds).toBeLessThanOrEqual(300)
    const job = await prisma.exportJob.findUniqueOrThrow({ where: { id: r.exportJobId } })
    expect(job).toMatchObject({ kind: 'REPORT', status: 'COMPLETED', fileId: r.fileId, checksum: r.checksum, requestedById: org.member.proc_officer, params: { reportCode: 'RISK_SUPPLIER_FILE', supplierId: main.supplierId } })
    expect((await prisma.fileObject.findUniqueOrThrow({ where: { id: r.fileId } })).sha256).toBe(r.checksum)
    expect(await prisma.event.findFirst({ where: { aggregateId: r.exportJobId, type: 'export.generated' } })).toMatchObject({ data: { kind: 'REPORT', checksum: r.checksum, fileId: r.fileId } })
    expect(await prisma.event.findFirst({ where: { aggregateId: r.fileId, type: 'file.downloaded' } })).toMatchObject({ actorMemberId: org.member.proc_officer, data: { fileId: r.fileId } })
  })

  it('the workbook carries every part of the file, the masked tax id and no name of an individual', async () => {
    const file = ok(await supplierRiskFile(org.ctxOf('proc_officer', NOW), person.supplierId))
    const { bytes, rows } = await riskFileWorkbook(file)
    expect(rows).toBeGreaterThan(0)
    expect(createHash('sha256').update(bytes).digest('hex')).toMatch(/^[0-9a-f]{64}$/)
    const book = new ExcelJS.Workbook()
    await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer)
    expect(book.worksheets.map((w) => w.name)).toEqual(['สรุป', 'ใบประเมิน', 'คำตอบ', 'ผู้ตรวจ', 'หลักฐาน', 'การอนุมัติข้าม', 'ประเมินซ้ำ', 'ไทม์ไลน์'])
    const summary = book.getWorksheet('สรุป')!
    expect(summary.getCell('B2').value).toBe('ผู้ขายบุคคลธรรมดา RF-02')
    expect(summary.getCell('B3').value).toBe('XXXXXXXXX3456')
    expect(book.getWorksheet('คำตอบ')!.rowCount).toBe(3)
  })

  it('a requester may not export it (deny): no file, no ExportJob', async () => {
    const before = await prisma.exportJob.count({ where: { organizationId: org.organizationId } })
    const r = await exportSupplierRiskFile(org.ctxOf('req_con', NOW), { supplierId: main.supplierId }, key())
    expect(r.ok ? null : r.error.code).toBe('FORBIDDEN')
    expect(await prisma.exportJob.count({ where: { organizationId: org.organizationId } })).toBe(before)
  })
})

describe('[BR-RSK-14] supplierRiskStatus for S10 and the other pages', () => {
  it('a reader of the risk files reads everything; a reader of the register only tier and status', async () => {
    expect(ok(await supplierRiskStatus(org.ctxOf('proc_officer', NOW), main.supplierId))).toEqual({ tier: 'HIGH', status: 'CURRENT', validUntil: '2026-12-15', currentAssessmentId: mainAssessment, openOverrideId: null })
    expect(ok(await supplierRiskStatus(org.ctxOf('req_con', NOW), main.supplierId))).toEqual({ tier: 'HIGH', status: 'CURRENT' })
    const badges = await supplierRiskBadges(org.ctxOf('req_con', NOW), [main.supplierId, person.supplierId])
    expect(badges.get(main.supplierId)).toEqual({ tier: 'HIGH', status: 'CURRENT' })
    const other = await createP2Org()
    expect((await supplierRiskBadges(other.ctxOf('proc_officer', NOW), [main.supplierId])).size).toBe(0)
  })

  it("the provider says whether today's gate would stop a PO: not while the assessment is current, yes once it lapsed", async () => {
    const db = forTenant(org.organizationId)
    expect(await db.$transaction((tx) => supplierRiskProvider(tx, org.organizationId, person.supplierId, NOW))).toMatchObject({ tier: 'HIGH', blocked: false, status: 'CURRENT', registryFlagBlocks: true })
    const lapsed = new Date('2026-12-20T03:00:00Z')
    expect(await db.$transaction((tx) => supplierRiskProvider(tx, org.organizationId, person.supplierId, lapsed))).toMatchObject({ tier: 'HIGH', blocked: true })
    const fresh = await supplierWithContact('RF-03')
    expect(await db.$transaction((tx) => supplierRiskProvider(tx, org.organizationId, fresh.supplierId, NOW))).toMatchObject({ tier: null, blocked: false, status: 'NOT_ASSESSED' })
  })
})

describe('[BR-RSK-14] /risk: what needs attention', () => {
  it('the suppliers running out, the open overrides and assessments, filtered by tier and status; a requester is refused', async () => {
    // the day's run moves the projection: a month before validUntil the suppliers are EXPIRING (BR-RSK-14)
    await runRiskReviewDaily(org.organizationId, NOW, { sender: null })
    const view = ok(await riskOverview(org.ctxOf('fin_officer', NOW)))
    expect(view.suppliers.map((s) => s.code)).toEqual(expect.arrayContaining(['RF-01', 'RF-02']))
    expect(view.suppliers.every((s) => ['EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED'].includes(s.status))).toBe(true)
    expect(view.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ number: 'RO-T-00001', expiringSoon: true })]))
    const notAssessed = ok(await riskOverview(org.ctxOf('fin_officer', NOW), { status: 'NOT_ASSESSED' }))
    expect(notAssessed.suppliers.every((s) => s.status === 'NOT_ASSESSED')).toBe(true)
    expect(ok(await riskOverview(org.ctxOf('fin_officer', NOW), { tier: 'LOW' })).suppliers).toHaveLength(0)
    const refused = await riskOverview(org.ctxOf('req_con', NOW))
    expect(refused.ok ? null : refused.error.code).toBe('FORBIDDEN')
  })
})

describe('[FR-RSK-204/AC4] evidence files kept risk.answerRetentionYears, then purged by risk-review-daily (OQ-230)', () => {
  it('kept the day before ten years from completion; then the link and the bytes go, FileObject and the events stay', async () => {
    const s = await supplierWithContact('RF-04')
    const id = await assessedAt(s, COMPLETED_AT)
    const fileId = await evidenceFile(id, 'RQ-PRV-01')
    const linkOf = () => prisma.fileLink.count({ where: { fileId, kind: 'RISK_EVIDENCE' } })
    await runRiskReviewDaily(org.organizationId, new Date('2035-12-14T07:15:00+07:00'), { sender: null })
    expect(await linkOf()).toBe(1)
    const run = await runRiskReviewDaily(org.organizationId, new Date('2035-12-16T07:15:00+07:00'), { sender: null })
    expect(run.evidencePurged).toBeGreaterThanOrEqual(1)
    expect(await linkOf()).toBe(0)
    expect(await prisma.fileObject.findUnique({ where: { id: fileId } })).not.toBeNull()
    expect(await prisma.riskAnswer.count({ where: { assessmentId: id } })).toBe(2)
    expect(await prisma.event.findFirst({ where: { aggregateId: id, type: 'risk_assessment.evidence_purged' } })).toMatchObject({ actorType: 'SYSTEM', data: { fileIds: [fileId], reason: 'RETENTION' } })
  })
})
