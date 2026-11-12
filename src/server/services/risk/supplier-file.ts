import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import type { RiskDomain, RiskTierCode } from '@/core/risk'
import { presignDownload, putObject } from '@/integrations/storage'
import { newId } from '@/lib/ids'
import { authorize, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { supplierRiskStatusIn, type SupplierRiskStatusCode } from '@/server/queries/risk'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { isIndividualTaxId, maskTaxId } from '../suppliers/access'

// The supplier's risk file (S11-10 · FR-RSK-204 AC1 AC3 · BR-RSK-14 BR-RSK-20): every assessment of the supplier with its
// answers and where each came from (the supplier, procurement for it, a certificate, an AI value a person confirmed), the
// documents and files behind them as metadata, the reviewers' slots and their results, every override with the POs that
// used it, the reassessments (RiskReview) and a timeline from the events. Read with risk.assessment.view (PROCUREMENT
// FINANCE EXECUTIVE AUDITOR); a return's reason only for PROCUREMENT and AUDITOR, as on the assessment's page. Opening a
// file stays with risk.evidence.view on the assessment's page. An individual's tax id is always masked here: the file
// never needs a national id number. The Excel copy is made by a POST command that records export.generated and
// file.downloaded and answers a five-minute link — no GET makes it.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string): Fail => ({ ok: false, error: { code, message } })
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

export type RiskAnswerSourceCode = 'EXPLICIT' | 'EVIDENCE' | 'ON_BEHALF'

export interface RiskFileAnswer {
  readonly questionCode: string
  readonly optionCode: string
  readonly source: RiskAnswerSourceCode
  /** The value the AI proposed and a person confirmed (BR-AI-33) */
  readonly aiConfirmed: boolean
  readonly points: number
  readonly answeredAt: Date
}

export interface RiskFileReviewSlot {
  readonly reviewRound: number
  readonly slotNo: number
  readonly riskDomains: readonly RiskDomain[]
  readonly status: 'OPEN' | 'PASSED' | 'RETURNED' | 'CANCELLED'
  readonly reviewerName: string
  readonly decidedAt: Date | null
  readonly reason: string | null
}

export interface RiskFileAssessment {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly inherentTier: RiskTierCode
  readonly tier: RiskTierCode | null
  readonly pointsTotal: number | null
  readonly openedAt: Date
  readonly submittedAt: Date | null
  readonly completedOn: string | null
  readonly validUntil: string | null
  readonly answers: readonly RiskFileAnswer[]
  readonly reviews: readonly RiskFileReviewSlot[]
}

export interface RiskFileDocument {
  readonly id: string
  readonly documentTypeCode: string
  readonly scope: string | null
  readonly expiresOn: string
  readonly status: string
  /** "RSA-… RQ-…" of the answers that rest on it */
  readonly usedBy: readonly { readonly assessmentNumber: string | null; readonly questionCode: string }[]
}

export interface RiskFileEvidenceFile {
  readonly fileId: string
  readonly fileName: string
  readonly scanStatus: string
  readonly assessmentNumber: string | null
  readonly questionCode: string
}

export interface RiskFileOverride {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly forPo: { readonly id: string; readonly number: string | null } | null
  readonly capGrossSatang: bigint
  readonly usedGrossSatang: bigint
  readonly expiresOn: string
  readonly decidedAt: Date | null
  readonly usedBy: readonly { readonly id: string; readonly number: string | null }[]
}

export interface RiskFileReview {
  readonly id: string
  readonly reason: string
  readonly status: string
  readonly tier: RiskTierCode | null
  readonly dueAt: Date
  readonly completedAt: Date | null
  readonly registryFlag: string | null
}

export interface RiskFileEvent {
  readonly id: string
  readonly type: string
  readonly occurredAt: Date
  readonly actorKind: 'MEMBER' | 'SUPPLIER' | 'SYSTEM' | 'OTHER'
  readonly actorName: string | null
}

export interface SupplierRiskFile {
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly taxId: string | null; readonly taxIdMasked: boolean; readonly individual: boolean; readonly registryFlag: string }
  readonly status: { readonly tier: RiskTierCode | null; readonly status: SupplierRiskStatusCode; readonly validUntil: string | null; readonly currentAssessmentId: string | null; readonly openOverrideId: string | null }
  readonly assessments: readonly RiskFileAssessment[]
  readonly documents: readonly RiskFileDocument[]
  readonly files: readonly RiskFileEvidenceFile[]
  readonly overrides: readonly RiskFileOverride[]
  readonly reviews: readonly RiskFileReview[]
  readonly timeline: readonly RiskFileEvent[]
  /** risk.assessment.manage: "เปิดแบบประเมิน" */
  readonly canManage: boolean
}

/** The newest events the file shows; the export carries the same */
export const RISK_FILE_TIMELINE_LIMIT = 200

const readsReasons = (manage: boolean, principal: Principal) => manage || (principal.kind === 'member' && principal.roles.has('AUDITOR'))

/** The file of one supplier, the right already checked; null for a supplier not of the organization */
async function fileOf(tx: TenantTx, supplierId: string, reasons: boolean, canManage: boolean): Promise<SupplierRiskFile | null> {
  const s = await tx.supplier.findFirst({ where: { id: supplierId }, select: { id: true, code: true, nameTh: true, nameEn: true, taxId: true, isForeign: true, registryFlag: true } })
  const status = s ? await supplierRiskStatusIn(tx, supplierId) : null
  if (!s || !status) return null
  const individual = isIndividualTaxId(s.taxId, s.isForeign)

  const assessments = await tx.riskAssessment.findMany({
    where: { supplierId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, status: true, inherentTier: true, tier: true, pointsTotal: true, createdAt: true, submittedAt: true, completedOn: true, validUntil: true },
  })
  const ids = assessments.map((a) => a.id)
  const answers = await tx.riskAnswer.findMany({
    where: { assessmentId: { in: ids }, optionCode: { not: null } },
    orderBy: [{ questionCode: 'asc' }],
    select: { id: true, assessmentId: true, questionCode: true, optionCode: true, source: true, points: true, answeredAt: true, agentActionId: true, evidenceDocumentId: true },
  })
  const tasks = await tx.reviewTask.findMany({ where: { assessmentId: { in: ids } }, orderBy: [{ reviewRound: 'desc' }, { slotNo: 'asc' }] })
  const memberIds = [...new Set(tasks.flatMap((x) => [x.assigneeMemberId, x.decidedById].filter((m): m is string => m !== null)))]
  const reviewers = await tx.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, displayNameTh: true } })
  const comments = reasons ? await tx.comment.findMany({ where: { id: { in: tasks.map((x) => x.reasonCommentId).filter((c): c is string => c !== null) }, retractedAt: null }, select: { id: true, body: true } }) : []
  const numberOf = new Map(assessments.map((a) => [a.id, a.number]))

  const docIds = [...new Set(answers.map((x) => x.evidenceDocumentId).filter((d): d is string => d !== null))]
  const docs = await tx.supplierDocument.findMany({ where: { id: { in: docIds } }, orderBy: [{ documentTypeCode: 'asc' }, { expiresOn: 'desc' }], select: { id: true, documentTypeCode: true, scope: true, expiresOn: true, status: true } })
  const links = await tx.fileLink.findMany({
    where: { kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: { in: answers.map((x) => x.id) } },
    select: { subjectId: true, file: { select: { id: true, fileName: true, scanStatus: true } } },
  })

  const overrides = await tx.riskOverride.findMany({
    where: { supplierId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, status: true, poId: true, capGrossSatang: true, usedGrossSatang: true, expiresOn: true, decidedAt: true },
  })
  const usedBy = await tx.purchaseOrder.findMany({ where: { riskOverrideId: { in: overrides.map((o) => o.id) } }, orderBy: [{ createdAt: 'asc' }], select: { id: true, number: true, riskOverrideId: true } })
  const named = await tx.purchaseOrder.findMany({ where: { id: { in: overrides.map((o) => o.poId).filter((p): p is string => p !== null) } }, select: { id: true, number: true } })
  const reviews = await tx.riskReview.findMany({ where: { supplierId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, reason: true, status: true, tier: true, dueAt: true, completedAt: true, registryFlag: true } })

  // the timeline: the supplier's risk events and every event of its assessments, overrides and reassessments
  const events = await tx.event.findMany({
    where: {
      OR: [
        { aggregateType: 'Supplier', aggregateId: supplierId, type: { in: ['supplier.risk_tier_changed', 'supplier.risk_status_changed'] } },
        { aggregateType: 'RiskAssessment', aggregateId: { in: ids } },
        { aggregateType: 'RiskOverride', aggregateId: { in: overrides.map((o) => o.id) } },
        { aggregateType: 'RiskReview', aggregateId: { in: reviews.map((r) => r.id) } },
      ],
    },
    orderBy: { seq: 'desc' },
    take: RISK_FILE_TIMELINE_LIMIT,
    select: { id: true, type: true, occurredAt: true, actorType: true, actorMemberId: true },
  })
  const actors = await tx.member.findMany({ where: { id: { in: [...new Set(events.map((e) => e.actorMemberId).filter((m): m is string => m !== null))] } }, select: { id: true, displayNameTh: true } })

  return {
    supplier: { id: s.id, code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, taxId: s.taxId && individual ? maskTaxId(s.taxId) : s.taxId, taxIdMasked: Boolean(s.taxId && individual), individual, registryFlag: s.registryFlag },
    status: { tier: status.tier, status: status.status, validUntil: status.validUntil, currentAssessmentId: status.currentAssessmentId, openOverrideId: status.openOverrideId },
    assessments: assessments.map((a) => ({
      id: a.id,
      number: a.number,
      status: a.status,
      inherentTier: a.inherentTier,
      tier: a.tier,
      pointsTotal: a.pointsTotal,
      openedAt: a.createdAt,
      submittedAt: a.submittedAt,
      completedOn: iso(a.completedOn),
      validUntil: iso(a.validUntil),
      answers: answers
        .filter((x) => x.assessmentId === a.id)
        .map((x) => ({ questionCode: x.questionCode, optionCode: x.optionCode!, source: x.source, aiConfirmed: x.agentActionId !== null, points: x.points, answeredAt: x.answeredAt })),
      reviews: tasks
        .filter((x) => x.assessmentId === a.id)
        .map((x) => ({
          reviewRound: x.reviewRound,
          slotNo: x.slotNo,
          riskDomains: x.riskDomains as RiskDomain[],
          status: x.status,
          reviewerName: reviewers.find((m) => m.id === (x.decidedById ?? x.assigneeMemberId))?.displayNameTh ?? '',
          decidedAt: x.decidedAt,
          reason: x.reasonCommentId ? (comments.find((c) => c.id === x.reasonCommentId)?.body ?? null) : null,
        })),
    })),
    documents: docs.map((d) => ({
      id: d.id,
      documentTypeCode: d.documentTypeCode,
      scope: d.scope,
      expiresOn: iso(d.expiresOn)!,
      status: d.status,
      usedBy: answers.filter((x) => x.evidenceDocumentId === d.id).map((x) => ({ assessmentNumber: numberOf.get(x.assessmentId) ?? null, questionCode: x.questionCode })),
    })),
    files: links.map((l) => {
      const answer = answers.find((x) => x.id === l.subjectId)!
      return { fileId: l.file.id, fileName: l.file.fileName, scanStatus: l.file.scanStatus, assessmentNumber: numberOf.get(answer.assessmentId) ?? null, questionCode: answer.questionCode }
    }),
    overrides: overrides.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      forPo: o.poId ? (named.find((p) => p.id === o.poId) ?? { id: o.poId, number: null }) : null,
      capGrossSatang: o.capGrossSatang,
      usedGrossSatang: o.usedGrossSatang,
      expiresOn: iso(o.expiresOn)!,
      decidedAt: o.decidedAt,
      usedBy: usedBy.filter((p) => p.riskOverrideId === o.id).map((p) => ({ id: p.id, number: p.number })),
    })),
    reviews: reviews.map((r) => ({ id: r.id, reason: r.reason, status: r.status, tier: r.tier, dueAt: r.dueAt, completedAt: r.completedAt, registryFlag: r.registryFlag })),
    timeline: events.map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt,
      actorKind: e.actorType === 'USER' ? 'MEMBER' : e.actorType === 'SUPPLIER' || e.actorType === 'SYSTEM' ? e.actorType : 'OTHER',
      // a supplier's contact stays unnamed: for an individual supplier the name is personal data (BR-RSK-20)
      actorName: e.actorMemberId ? (actors.find((m) => m.id === e.actorMemberId)?.displayNameTh ?? null) : null,
    })),
    canManage,
  }
}

/** /suppliers/[id] tab "ความเสี่ยง" and /risk/suppliers/[id] (FR-RSK-204 AC1) */
export async function supplierRiskFile(ctx: Ctx, supplierId: string): Promise<Result<SupplierRiskFile>> {
  if (!z.uuid().safeParse(supplierId).success) return fail('NOT_FOUND', 'supplier not found')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'risk.assessment.view')
    if (!may.ok) return may
    const manage = (await authorize(tx, ctx, 'risk.assessment.manage')).ok
    const file = await fileOf(tx, supplierId, readsReasons(manage, may.data), manage)
    return file ? { ok: true as const, data: file } : fail('NOT_FOUND', 'supplier not found')
  })
}

// ---------- risk.exportSupplierFile: the file as Excel, its sha256, and the reader's download (FR-RSK-204 AC3) ----------

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const DOWNLOAD_TTL_SECONDS = 300
const thDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '')
const baht = (satang: bigint) => `${satang / 100n}.${String(satang % 100n).padStart(2, '0')}`

/** The workbook: one sheet per part of the file, codes and dates as the screen shows them, no free text of a supplier */
export async function riskFileWorkbook(file: SupplierRiskFile): Promise<{ bytes: Uint8Array; rows: number }> {
  const book = new ExcelJS.Workbook()
  const s = file.supplier
  const summary = book.addWorksheet('สรุป')
  summary.addRows([
    ['รหัสผู้ขาย', s.code],
    ['ชื่อ', s.individual ? `ผู้ขายบุคคลธรรมดา ${s.code}` : s.nameTh],
    ['เลขผู้เสียภาษี', s.taxId ?? ''],
    ['ระดับความเสี่ยง', file.status.tier ?? 'ยังไม่ประเมิน'],
    ['สถานะ', file.status.status],
    ['ใช้ได้ถึง', file.status.validUntil ?? ''],
    ['ธงทะเบียน', s.registryFlag],
  ])
  let rows = 0
  const sheet = (name: string, head: readonly string[], body: ReadonlyArray<ReadonlyArray<string | number>>) => {
    const ws = book.addWorksheet(name)
    ws.addRow([...head])
    for (const r of body) ws.addRow([...r])
    rows += body.length
  }
  sheet(
    'ใบประเมิน',
    ['เลขที่', 'สถานะ', 'ระดับตั้งต้น', 'คะแนน', 'ระดับ', 'เปิดเมื่อ', 'ส่งเมื่อ', 'เสร็จวันที่', 'ใช้ได้ถึง'],
    file.assessments.map((a) => [a.number ?? '', a.status, a.inherentTier, a.pointsTotal ?? '', a.tier ?? '', thDate(a.openedAt), thDate(a.submittedAt), a.completedOn ?? '', a.validUntil ?? '']),
  )
  sheet(
    'คำตอบ',
    ['ใบประเมิน', 'คำถาม', 'คำตอบ', 'ที่มา', 'AI เสนอ คนยืนยัน', 'คะแนน', 'ตอบเมื่อ'],
    file.assessments.flatMap((a) => a.answers.map((x) => [a.number ?? '', x.questionCode, x.optionCode, x.source, x.aiConfirmed ? 'ใช่' : '', x.points, thDate(x.answeredAt)])),
  )
  sheet(
    'ผู้ตรวจ',
    ['ใบประเมิน', 'รอบ', 'ช่อง', 'ส่วน', 'สถานะ', 'ผู้ตรวจ', 'ตัดสินเมื่อ', 'เหตุผล'],
    file.assessments.flatMap((a) => a.reviews.map((r) => [a.number ?? '', r.reviewRound, r.slotNo, r.riskDomains.join(' '), r.status, r.reviewerName, thDate(r.decidedAt), r.reason ?? ''])),
  )
  sheet(
    'หลักฐาน',
    ['ชนิด', 'เอกสารหรือไฟล์', 'ขอบเขต', 'หมดอายุ', 'สถานะ', 'ใช้ตอบ'],
    [
      ...file.documents.map((d) => ['เอกสารผู้ขาย', d.documentTypeCode, d.scope ?? '', d.expiresOn, d.status, d.usedBy.map((u) => `${u.assessmentNumber ?? ''} ${u.questionCode}`).join(', ')]),
      ...file.files.map((f) => ['ไฟล์ประกอบคำตอบ', f.fileName, '', '', f.scanStatus, `${f.assessmentNumber ?? ''} ${f.questionCode}`]),
    ],
  )
  sheet(
    'การอนุมัติข้าม',
    ['เลขที่', 'สถานะ', 'สำหรับ PO', 'เพดานรวม VAT', 'ใช้แล้ว', 'ใช้ได้ถึง', 'PO ที่ใช้'],
    file.overrides.map((o) => [o.number ?? '', o.status, o.forPo?.number ?? (o.forPo ? '-' : 'ทุก PO'), baht(o.capGrossSatang), baht(o.usedGrossSatang), o.expiresOn, o.usedBy.map((p) => p.number ?? '').join(', ')]),
  )
  sheet(
    'ประเมินซ้ำ',
    ['เหตุ', 'สถานะ', 'ระดับ', 'กำหนด', 'เสร็จเมื่อ', 'ธงทะเบียน'],
    file.reviews.map((r) => [r.reason, r.status, r.tier ?? '', thDate(r.dueAt), thDate(r.completedAt), r.registryFlag ?? '']),
  )
  sheet(
    'ไทม์ไลน์',
    ['เมื่อ', 'เหตุการณ์', 'ผู้ทำ'],
    file.timeline.map((e) => [e.occurredAt.toISOString(), e.type, e.actorName ?? e.actorKind]),
  )
  return { bytes: new Uint8Array(await book.xlsx.writeBuffer()), rows }
}

const exportCommand = defineCommand({
  name: 'risk.exportSupplierFile',
  capability: 'risk.assessment.view',
  input: z.strictObject({ supplierId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ exportJobId: string; fileId: string; rowCount: number; checksum: string; storageKey: string; fileName: string }>> {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'risk.assessment.view')
    if (!may.ok) return may
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!memberId) return fail('FORBIDDEN', 'only a member exports a risk file')
    const manage = (await authorize(tx, ctx, 'risk.assessment.manage')).ok
    const file = await fileOf(tx, input.supplierId, readsReasons(manage, may.data), manage)
    if (!file) return fail('NOT_FOUND', 'supplier not found')
    const { bytes, rows } = await riskFileWorkbook(file)
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const fileId = newId()
    const exportJobId = newId()
    const fileName = `risk-file-${file.supplier.code}.xlsx`
    const storageKey = `${ctx.organizationId}/exports/${exportJobId}.xlsx`
    await putObject(storageKey, bytes, XLSX)
    await tx.fileObject.create({ data: { id: fileId, organizationId: ctx.organizationId, storageKey, fileName, mimeType: XLSX, sizeBytes: bytes.length, sha256: checksum, status: 'AVAILABLE', uploadedById: memberId } })
    await tx.exportJob.create({
      data: { id: exportJobId, organizationId: ctx.organizationId, kind: 'REPORT', params: { reportCode: 'RISK_SUPPLIER_FILE', supplierId: input.supplierId }, status: 'COMPLETED', fileId, rowCount: rows, checksum, requestedById: memberId, completedAt: ctx.now },
    })
    return {
      ok: true,
      result: { exportJobId, fileId, rowCount: rows, checksum, storageKey, fileName },
      events: [
        { type: 'export.generated', aggregateType: 'ExportJob', aggregateId: exportJobId, data: { kind: 'REPORT', rowCount: rows, totalSatang: '0', checksum, fileId, invoiceIds: [], excludedInvoiceIds: [], again: false } },
        { type: 'file.downloaded', aggregateType: 'File', aggregateId: fileId, data: { fileId } },
      ],
    }
  },
})

/** "ส่งออก Excel" of the risk file (a POST): the file made, both events written, and a five-minute link to it */
export async function exportSupplierRiskFile(ctx: Ctx, input: { supplierId: string }, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number; exportJobId: string; fileId: string; checksum: string; rowCount: number }>> {
  const r = await runCommand(ctx, exportCommand, input, options)
  if (!r.ok) return r
  const url = await presignDownload(r.data.storageKey, { fileName: r.data.fileName, contentType: XLSX, inline: false }, DOWNLOAD_TTL_SECONDS)
  return { ok: true, data: { url, expiresInSeconds: DOWNLOAD_TTL_SECONDS, exportJobId: r.data.exportJobId, fileId: r.data.fileId, checksum: r.data.checksum, rowCount: r.data.rowCount } }
}
