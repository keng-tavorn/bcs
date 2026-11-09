import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { RISK_ASSESSMENT_MACHINE, transition } from '@/core/state-machines'
import { deleteObject, presignDownload, putObject } from '@/integrations/storage'
import { MS_PER_HOUR, RISK_EVIDENCE_FILES_PER_QUESTION, SUPPLIER_DOC_MAX_BYTES } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { riskSettingsOf } from '@/lib/org-settings'
import { PORTAL_PRIVACY_NOTICE_VERSION, PORTAL_UPLOADS_PER_HOUR } from '@/lib/portal-limits'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { countPortalScopeHit } from '@/server/db/portal'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { requestSupplierDocumentDownload, sniffSupplierFile, type SupplierFileMime } from '../suppliers/documents'
import { contactMay } from './assessments'
import { RISK_SUPPLIER_TEMPLATES } from './templates'

// The files behind a risk answer (S11-05 · BR-RSK-18 · BR-AI-34 · FR-RSK-204 AC4): PDF, JPEG, PNG or WebP by their bytes,
// at most 20 MB and RISK_EVIDENCE_FILES_PER_QUESTION per answer, kept private and PENDING until S7's central scan
// (job file-scan on file.uploaded) calls them CLEAN; an INFECTED one loses its link (the file kept for the audit) and the
// supplier is told to send another (riskEvidenceScanned, job risk-evidence-scanned on file.scanned). The uploader says
// per answer whether the AI may read its files (RiskAnswer.evidenceAiReadable).

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const EXTENSION: Record<SupplierFileMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const UploadInput = z.strictObject({
  assessmentId: z.uuid(),
  questionCode: z.string().trim().min(1).max(20),
  aiReadable: z.boolean().optional(),
  file: z.strictObject({ storageKey: z.string().min(1), fileName: z.string().min(1).max(200), mimeType: z.string(), sizeBytes: z.int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
})

const uploadCommand = defineCommand({
  name: 'riskAssessment.evidence.upload',
  capability: 'portal.risk.evidence.upload',
  input: UploadInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fileId: string; answerId: string }>> {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return { ok: false, error: on.error }
    await lockRowsForUpdate(tx, 'RiskAssessment', ctx.organizationId, [input.assessmentId])
    const a = await tx.riskAssessment.findFirst({
      where: { id: input.assessmentId },
      select: { id: true, status: true, supplierId: true, answers: { where: { questionCode: input.questionCode }, select: { id: true, evidenceAiReadable: true } } },
    })
    if (!a) return fail('NOT_FOUND', 'assessment not found')
    if (ctx.actor.type === 'SUPPLIER') {
      const may = await contactMay(tx, ctx, a, 'portal.risk.evidence.upload')
      if (!may.ok) return may
      // as answer and submit: an organization that answers for its suppliers takes no file from their contacts
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
      if (!riskSettingsOf(org.settings).portalAnswering) return fail('FORBIDDEN', 'the organization answers for its suppliers', { reason: 'PORTAL_ANSWERING_OFF' })
      // BR-PORTAL ข้อ 08: nothing is uploaded before the current privacy notice (which tells of the AI) is accepted
      const contact = await tx.supplierContact.findUniqueOrThrow({ where: { id: ctx.actor.supplierContactId }, select: { privacyNoticeVersion: true } })
      if (contact.privacyNoticeVersion !== PORTAL_PRIVACY_NOTICE_VERSION) return fail('PRIVACY_NOTICE_OUTDATED', 'the current privacy notice is not accepted yet', { version: PORTAL_PRIVACY_NOTICE_VERSION })
    } else {
      const may = await authorize(tx, ctx, 'risk.assessment.manage')
      if (!may.ok) return { ok: false, error: may.error }
    }
    const t = transition(RISK_ASSESSMENT_MACHINE, a.status, 'riskAssessment.answer')
    if (!t.ok) return fail('INVALID_STATE_TRANSITION', `the assessment takes no files while ${a.status}`, { from: a.status, command: 'riskAssessment.answer' })
    const answer = a.answers[0]
    if (!answer) return fail('VALIDATION_FAILED', 'answer the question before attaching its evidence', { reason: 'ANSWER_FIRST', questionCode: input.questionCode })
    const linked = await tx.fileLink.count({ where: { subjectType: 'RiskAnswer', subjectId: answer.id, kind: 'RISK_EVIDENCE' } })
    if (linked >= RISK_EVIDENCE_FILES_PER_QUESTION) return fail('VALIDATION_FAILED', `at most ${RISK_EVIDENCE_FILES_PER_QUESTION} files a question`, { reason: 'TOO_MANY_FILES', questionCode: input.questionCode })
    const fileId = newId()
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    await tx.fileObject.create({
      data: { id: fileId, organizationId: ctx.organizationId, storageKey: input.file.storageKey, fileName: input.file.fileName, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes, sha256: input.file.sha256, status: 'AVAILABLE', uploadedById: memberId, scanStatus: 'PENDING' },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'RiskAnswer', subjectId: answer.id, kind: 'RISK_EVIDENCE' } })
    // BR-AI-34: the AI reads the files of an answer only when every one of them was ticked as it was sent — one file sent
    // unticked keeps them all from the AI, and a later tick never opens a file sent before without one
    const aiReadable = input.aiReadable === true && (linked === 0 || answer.evidenceAiReadable)
    if (aiReadable !== answer.evidenceAiReadable) await tx.riskAnswer.update({ where: { id: answer.id }, data: { evidenceAiReadable: aiReadable } })
    await tx.riskAssessment.update({ where: { id: a.id }, data: { lastActivityAt: ctx.now, version: { increment: 1 } } })
    return {
      ok: true,
      result: { fileId, answerId: answer.id },
      events: [
        { type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes } },
        { type: 'risk_assessment.evidence_uploaded', aggregateType: 'RiskAssessment', aggregateId: a.id, data: { questionCode: input.questionCode, fileId, aiReadable: input.aiReadable ?? null, by: ctx.actor.type === 'SUPPLIER' ? 'CONTACT' : 'MEMBER' } },
      ],
    }
  },
})

export interface UploadEvidenceInput {
  readonly assessmentId: string
  readonly questionCode: string
  readonly fileName: string
  readonly bytes: Uint8Array
  readonly aiReadable?: boolean
}

/** One file behind an answer; the bytes are checked before anything is stored, and a refused upload keeps nothing */
export async function uploadRiskEvidence(ctx: Ctx, input: UploadEvidenceInput, options: RunOptions): Promise<Result<{ fileId: string; answerId: string }>> {
  if (input.bytes.byteLength === 0) return fail('VALIDATION_FAILED', 'the file is empty', { field: 'file', reason: 'EMPTY' })
  if (input.bytes.byteLength > SUPPLIER_DOC_MAX_BYTES) return fail('VALIDATION_FAILED', 'the file is larger than 20 MB', { field: 'file', reason: 'TOO_LARGE' })
  const mime = sniffSupplierFile(input.bytes)
  if (!mime) return fail('VALIDATION_FAILED', 'only PDF, JPEG, PNG or WebP', { field: 'file', reason: 'TYPE_NOT_ALLOWED' })
  if (ctx.actor.type === 'SUPPLIER' && ctx.actor.supplierId) {
    // the portal's upload bucket of S7 (BR-PORTAL ข้อ 07): documents and evidence count together per supplier
    const windowStart = new Date(Math.floor(ctx.now.getTime() / MS_PER_HOUR) * MS_PER_HOUR)
    if ((await countPortalScopeHit(ctx.organizationId, { kind: 'SUPPLIER', key: ctx.actor.supplierId }, 'UPLOAD', windowStart)) > PORTAL_UPLOADS_PER_HOUR) return fail('RATE_LIMITED', 'too many files this hour')
  }
  const storageKey = `${ctx.organizationId}/risk-evidence/${newId()}.${EXTENSION[mime]}`
  await putObject(storageKey, input.bytes, mime)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const recorded = await runCommand(
    ctx,
    uploadCommand,
    { assessmentId: input.assessmentId, questionCode: input.questionCode, aiReadable: input.aiReadable, file: { storageKey, fileName: input.fileName.slice(0, 200) || 'evidence', mimeType: mime, sizeBytes: input.bytes.byteLength, sha256 } },
    options,
  )
  if (!recorded.ok) await deleteObject(storageKey).catch(() => undefined)
  else {
    // a repeated request (same key) answers the first file: the copy this one stored is not kept unlisted
    const kept = await forTenant(ctx.organizationId).fileObject.findUnique({ where: { id: recorded.data.fileId }, select: { storageKey: true } })
    if (kept?.storageKey !== storageKey) await deleteObject(storageKey).catch(() => undefined)
  }
  return recorded
}

// ---------- the scan's answer for evidence (job risk-evidence-scanned · BR-RSK-18) ----------

const scannedCommand = defineCommand({
  name: 'riskAssessment.evidence_scanned',
  capability: 'system.risk',
  input: z.strictObject({ fileId: z.uuid() }),
  async execute(tx: TenantTx, input, ctx): Promise<CommandOutcome<{ outcome: 'REJECTED' }>> {
    const link = await tx.fileLink.findFirst({ where: { fileId: input.fileId, kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer' }, select: { id: true, subjectId: true } })
    if (!link) return fail('INVALID_STATE_TRANSITION', 'no evidence link of this file')
    const answer = await tx.riskAnswer.findUnique({ where: { id: link.subjectId }, select: { questionCode: true, answeredByContactId: true, assessment: { select: { id: true, number: true, supplierId: true, status: true } } } })
    if (!answer) return fail('NOT_FOUND', 'answer not found')
    // the link goes, the file stays for the audit; the answer stays (BR-RSK-18)
    await tx.fileLink.delete({ where: { id: link.id } })
    const told = await enqueueSupplierNotice(tx, ctx, {
      templateKey: RISK_SUPPLIER_TEMPLATES.evidenceRejected,
      supplierId: answer.assessment.supplierId,
      contactId: answer.answeredByContactId,
      subjectType: 'RiskAssessment',
      subjectId: answer.assessment.id,
      dedupeKey: `risk_evidence_rejected:${input.fileId}`,
      data: { number: answer.assessment.number, questionCode: answer.questionCode },
    })
    return {
      ok: true,
      result: { outcome: 'REJECTED' },
      events: [{ type: 'risk_assessment.evidence_rejected', aggregateType: 'RiskAssessment', aggregateId: answer.assessment.id, data: { questionCode: answer.questionCode, fileId: input.fileId } }, ...told.events],
      notifications: told.notifications,
      outbox: told.outbox,
    }
  },
})

// ---------- opening the evidence (risk.evidence.view · BR-RSK-14) ----------

const DOWNLOAD_TTL_SECONDS = 300

/**
 * risk.evidence.view with RISK on, inside the caller's transaction: PROCUREMENT FINANCE AUDITOR (ORG), or the holder of a
 * reviewer's slot of the assessment whose domains (GENERAL and its own · BR-RSK-08) hold the question of the answer
 * (ASSIGNED · S11-06)
 */
async function evidenceViewer(tx: TenantTx, ctx: Ctx, answer?: { readonly assessmentId: string; readonly questionCode: string }): Promise<{ ok: true } | Fail> {
  const on = await requireModule(ctx, 'RISK', tx)
  if (!on.ok) return { ok: false, error: on.error }
  // without an answer no slot is named: only the roles open it (an ASSIGNED grant asked without a resource would let anyone in)
  const may = await authorize(tx, ctx, 'risk.evidence.view', { assigneeMemberIds: answer ? await slotHoldersSeeing(tx, answer.assessmentId, answer.questionCode) : [] })
  return may.ok ? { ok: true } : { ok: false, error: may.error }
}

/** The members who hold or held a reviewer's slot of the assessment that sees the question's domain (BR-RSK-08) */
async function slotHoldersSeeing(tx: TenantTx, assessmentId: string, questionCode: string): Promise<string[]> {
  const a = await tx.riskAssessment.findUniqueOrThrow({ where: { id: assessmentId }, select: { questionnaireId: true } })
  const question = await tx.riskQuestion.findFirst({ where: { questionnaireId: a.questionnaireId, code: questionCode }, select: { domain: true } })
  if (!question) return []
  // every task of the assessment, a cancelled one too: its holder still reads the slot's page (riskReviewTaskPage)
  const tasks = await tx.reviewTask.findMany({ where: { assessmentId }, select: { riskDomains: true, assigneeMemberId: true, delegatorMemberId: true, decidedById: true } })
  return [
    ...new Set(
      tasks
        .filter((t) => question.domain === 'GENERAL' || t.riskDomains.includes(question.domain))
        .flatMap((t) => [t.assigneeMemberId, t.delegatorMemberId, t.decidedById])
        .filter((m): m is string => typeof m === 'string'),
    ),
  ]
}

const evidenceDownloadCommand = defineCommand({
  name: 'riskAssessment.evidence.download',
  capability: 'risk.evidence.view',
  input: z.strictObject({ assessmentId: z.uuid(), fileId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ storageKey: string; fileName: string; mimeType: string }>> {
    const answers = await tx.riskAnswer.findMany({ where: { assessmentId: input.assessmentId }, select: { id: true, questionCode: true } })
    const link = await tx.fileLink.findFirst({
      where: { fileId: input.fileId, kind: 'RISK_EVIDENCE', subjectType: 'RiskAnswer', subjectId: { in: answers.map((x) => x.id) } },
      select: { subjectId: true, file: { select: { storageKey: true, fileName: true, mimeType: true, scanStatus: true } } },
    })
    // the right first, the file's existence after: who may not open it learns nothing of it
    const questionCode = link ? answers.find((x) => x.id === link.subjectId)?.questionCode : undefined
    const may = await evidenceViewer(tx, ctx, questionCode ? { assessmentId: input.assessmentId, questionCode } : undefined)
    if (!may.ok) return may
    if (!link) return fail('NOT_FOUND', 'no such file behind an answer of this assessment')
    // a file opens once the central scan called it clean (S7's file-scan)
    if (link.file.scanStatus !== 'CLEAN') return fail(link.file.scanStatus === 'INFECTED' ? 'FILE_INFECTED' : 'FILE_NOT_SCANNED', 'the file is not clean', { scanStatus: link.file.scanStatus })
    return {
      ok: true,
      result: { storageKey: link.file.storageKey, fileName: link.file.fileName, mimeType: link.file.mimeType },
      events: [{ type: 'file.downloaded', aggregateType: 'File', aggregateId: input.fileId, data: { fileId: input.fileId } }],
    }
  },
})

/** A five-minute link to one evidence file of an assessment, after the checks and the event (a POST, never a GET) */
export async function requestRiskEvidenceDownload(ctx: Ctx, input: { assessmentId: string; fileId: string }, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number }>> {
  const r = await runCommand(ctx, evidenceDownloadCommand, input, options)
  if (!r.ok) return r
  return { ok: true, data: { url: await presignDownload(r.data.storageKey, { fileName: r.data.fileName, contentType: r.data.mimeType, inline: true }, DOWNLOAD_TTL_SECONDS), expiresInSeconds: DOWNLOAD_TTL_SECONDS } }
}

/**
 * The supplier's certificate an evidence answer of the assessment rests on: risk.evidence.view here, then S7's
 * supplierDocument.requestDownload with the same context (its own right, scan check and log of a sensitive type)
 */
export async function requestRiskEvidenceDocumentDownload(ctx: Ctx, input: { assessmentId: string; documentId: string }, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number }>> {
  const behind = await forTenant(ctx.organizationId).$transaction(async (tx): Promise<{ ok: true } | Fail> => {
    const answer = await tx.riskAnswer.findFirst({ where: { assessmentId: input.assessmentId, evidenceDocumentId: input.documentId }, select: { questionCode: true } })
    const may = await evidenceViewer(tx, ctx, answer ? { assessmentId: input.assessmentId, questionCode: answer.questionCode } : undefined)
    if (!may.ok) return may
    return answer ? { ok: true } : fail('NOT_FOUND', 'no answer of this assessment rests on the document')
  })
  if (!behind.ok) return behind
  return requestSupplierDocumentDownload(ctx, { documentId: input.documentId, purpose: 'ตรวจแบบประเมินความเสี่ยงคู่ค้า' }, options)
}

/** The listener of file.scanned for RISK_EVIDENCE: INFECTED → the link removed and the supplier told; CLEAN → nothing */
export async function riskEvidenceScanned(organizationId: string, fileId: string, result: 'CLEAN' | 'INFECTED', now: Date): Promise<'REJECTED' | 'SKIPPED'> {
  if (result === 'CLEAN') return 'SKIPPED'
  const done = await runCommand(systemCtx(organizationId, now, 'risk-evidence-scanned'), scannedCommand, { fileId }, { idempotencyKey: `risk-evidence-scanned:${fileId}` })
  return done.ok ? done.data.outcome : 'SKIPPED'
}
