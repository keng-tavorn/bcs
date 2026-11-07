import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { canVerify, dateIn, documentExpiry, documentStatus, normalizeScope, supersedeTargets, type IsoDate } from '@/core/supplier-docs'
import { getScanner } from '@/integrations/scanner'
import { presignDownload, putObject, readObject } from '@/integrations/storage'
import { MS_PER_HOUR, SUPPLIER_DOC_MAX_BYTES, SUPPLIER_DOC_MAX_VALIDITY_DAYS } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { PORTAL_PRIVACY_NOTICE_VERSION, PORTAL_UPLOADS_PER_HOUR } from '@/lib/portal-limits'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { countPortalScopeHit, organizationsWithSupplier } from '@/server/db/portal'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { OutboxDraft } from '@/server/events/outbox'
import type { NotificationDraft } from '@/server/notifications/create'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { PORTAL_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-portal'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'

// Supplier documents (S7-06 · ADR-185 · BR-SDOC ข้อ 01 ถึง ข้อ 06 · BR-PORTAL ข้อ 07 · FR-SUP-102 AC4 ถึง AC7): a file a
// supplier (or PROCUREMENT for it) uploads under a document type of the organization — PDF, JPEG, PNG or WebP by their
// bytes, at most 20 MB, kept private and PENDING until the central scan calls it CLEAN; PROCUREMENT verifies it once
// (a new verified copy supersedes the old one of its type and scope) or rejects it; a daily job reminds before it
// expires and expires it after. Downloads are POSTs that answer a URL of five minutes; a sensitive type (an ID card) is
// logged in SensitiveAccessLog every time. The dates are calendar dates of Asia/Bangkok (core/supplier-docs).

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

export const DOCUMENT_TIMEZONE = 'Asia/Bangkok'
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const toDate = (d: IsoDate) => new Date(`${d}T00:00:00Z`)
const isoOf = (d: Date) => d.toISOString().slice(0, 10)

// ---------- the file: what a supplier may send (BR-PORTAL ข้อ 07) ----------

export type SupplierFileMime = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'

/** The type the bytes are, among the four the portal takes; null for anything else */
export function sniffSupplierFile(bytes: Uint8Array): SupplierFileMime | null {
  const at = (offset: number, sig: readonly number[]) => sig.every((b, i) => bytes[offset + i] === b)
  if (at(0, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf'
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return null
}

const EXTENSION: Record<SupplierFileMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

// ---------- who acts ----------

interface Owner {
  readonly supplierId: string | null
  readonly applicationId: string | null
}

/** A contact acts on its own supplier or application (portal); a member with the capability on any */
async function actingOn(tx: TenantTx, ctx: Ctx, owner: Owner, capability: 'supplier.document.manage' | 'supplier.document.verify' | 'supplier.document.view'): Promise<{ readonly side: 'CONTACT' | 'MEMBER' } | Fail> {
  const on = await requireModule(ctx, 'SUPPLIER', tx)
  if (!on.ok) return { ok: false, error: on.error }
  if (ctx.actor.type === 'SUPPLIER') {
    if (capability === 'supplier.document.verify') return fail('FORBIDDEN', 'a contact does not verify documents')
    const mine = ctx.channel === 'PORTAL' && ((owner.supplierId !== null && owner.supplierId === ctx.actor.supplierId) || (owner.applicationId !== null && owner.applicationId === ctx.actor.applicationId))
    return mine ? { side: 'CONTACT' } : fail('FORBIDDEN', 'the contact acts on its own documents only', { action: capability === 'supplier.document.view' ? 'portal.document.view' : 'portal.document.upload' })
  }
  const may = await authorize(tx, ctx, capability)
  return may.ok ? { side: 'MEMBER' } : { ok: false, error: may.error }
}

// ---------- supplierDocument.upload ----------

/** Counts one upload of a supplier or an application in its hour (PortalRateLimit · BR-PORTAL ข้อ 04); true while within the limit */
async function withinUploadLimit(organizationId: string, scope: { readonly kind: 'SUPPLIER' | 'APPLICATION'; readonly key: string }, now: Date): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / MS_PER_HOUR) * MS_PER_HOUR)
  return (await countPortalScopeHit(organizationId, scope, 'UPLOAD', windowStart)) <= PORTAL_UPLOADS_PER_HOUR
}

const UploadInput = z
  .object({
    supplierId: z.uuid().nullable().default(null),
    applicationId: z.uuid().nullable().default(null),
    documentTypeCode: z.string().min(1).max(40),
    docNumber: z.string().trim().max(100).nullable().default(null),
    issuer: z.string().trim().max(200).nullable().default(null),
    scope: z.string().trim().max(200).nullable().default(null),
    issuedOn: ISO,
    expiresOn: ISO.nullable().default(null),
    /** Written by the adapter before the command: the stored object, its type by its bytes, size and sha256 */
    file: z.object({ storageKey: z.string().min(1), fileName: z.string().min(1).max(200), mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']), sizeBytes: z.int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  })
  .refine((v) => (v.supplierId === null) !== (v.applicationId === null), { message: 'one owner', path: ['supplierId'] })

const uploadCommand = defineCommand({
  name: 'supplierDocument.upload',
  capability: 'supplier.document.manage',
  input: UploadInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ documentId: string; fileId: string }>> {
    const owner = { supplierId: input.supplierId, applicationId: input.applicationId }
    const who = await actingOn(tx, ctx, owner, 'supplier.document.manage')
    if ('ok' in who) return who
    if (who.side === 'CONTACT' && ctx.actor.type === 'SUPPLIER') {
      // BR-PORTAL ข้อ 08: nothing is uploaded before the current privacy notice is accepted
      const contact = await tx.supplierContact.findUniqueOrThrow({ where: { id: ctx.actor.supplierContactId }, select: { privacyNoticeVersion: true } })
      if (contact.privacyNoticeVersion !== PORTAL_PRIVACY_NOTICE_VERSION) return fail('PRIVACY_NOTICE_OUTDATED', 'the current privacy notice is not accepted yet', { version: PORTAL_PRIVACY_NOTICE_VERSION })
    }
    const type = await tx.supplierDocumentType.findFirst({ where: { code: input.documentTypeCode, active: true } })
    if (!type) return fail('VALIDATION_FAILED', 'no such document type', { field: 'documentTypeCode', reason: 'TYPE' })
    if (input.applicationId) {
      const app = await tx.supplierApplication.findUnique({ where: { id: input.applicationId }, select: { status: true, payeeType: true } })
      if (!app) return fail('NOT_FOUND', 'application not found')
      if (!['INVITED', 'DRAFT', 'RETURNED', 'SUBMITTED'].includes(app.status)) return fail('INVALID_STATE_TRANSITION', 'the application takes no more documents', { status: app.status })
      if (!type.appliesTo.includes(app.payeeType)) return fail('VALIDATION_FAILED', 'this type is not for this payee', { field: 'documentTypeCode', reason: 'PAYEE_TYPE' })
    } else if (!(await tx.supplier.findUnique({ where: { id: input.supplierId! }, select: { id: true } }))) return fail('NOT_FOUND', 'supplier not found')
    const dates = documentExpiry({ validityDays: type.validityDays, reminderDaysBefore: type.reminderDaysBefore }, { issuedOn: input.issuedOn, expiresOn: input.expiresOn }, dateIn(ctx.now, DOCUMENT_TIMEZONE))
    if (!dates.ok) return fail('VALIDATION_FAILED', 'the dates of the document are not valid', { field: 'issuedOn', reason: dates.reason })
    const fileId = newId()
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    await tx.fileObject.create({
      data: { id: fileId, organizationId: ctx.organizationId, storageKey: input.file.storageKey, fileName: input.file.fileName, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes, sha256: input.file.sha256, status: 'AVAILABLE', uploadedById: memberId, scanStatus: 'PENDING' },
    })
    const documentId = newId()
    await tx.supplierDocument.create({
      data: {
        id: documentId,
        organizationId: ctx.organizationId,
        supplierId: input.supplierId,
        applicationId: input.applicationId,
        documentTypeCode: type.code,
        fileId,
        docNumber: input.docNumber,
        issuer: input.issuer,
        scope: input.scope,
        scopeKey: type.singleInstance ? '' : normalizeScope(input.scope),
        issuedOn: toDate(input.issuedOn),
        expiresOn: toDate(dates.expiresOn),
        statedExpiresOn: dates.statedExpiresOn ? toDate(dates.statedExpiresOn) : null,
        uploadedByContactId: ctx.actor.type === 'SUPPLIER' ? ctx.actor.supplierContactId : null,
        uploadedByMemberId: memberId,
      },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'SupplierDocument', subjectId: documentId, kind: 'SUPPLIER_DOC' } })
    if (input.applicationId) await tx.supplierApplication.update({ where: { id: input.applicationId }, data: { lastActivityAt: ctx.now } })
    return {
      ok: true,
      result: { documentId, fileId },
      events: [
        { type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes } },
        { type: 'supplier_document.uploaded', aggregateType: 'SupplierDocument', aggregateId: documentId, data: { ...owner, documentTypeCode: type.code, fileId, by: who.side } },
      ],
    }
  },
})

export interface UploadDocumentInput {
  readonly supplierId?: string | null
  readonly applicationId?: string | null
  readonly documentTypeCode: string
  readonly docNumber?: string | null
  readonly issuer?: string | null
  readonly scope?: string | null
  readonly issuedOn: string
  readonly expiresOn?: string | null
  readonly fileName: string
  readonly bytes: Uint8Array
}

/**
 * Upload of one document (BR-PORTAL ข้อ 07): the bytes checked here — size, then the type by its bytes — and stored in the
 * private bucket, then the command records it. A supplier or an application uploads at most PORTAL_UPLOADS_PER_HOUR files
 * an hour (BR-PORTAL ข้อ 04). An object stored for a refused command is left to the bucket's lifecycle.
 */
export async function uploadSupplierDocument(ctx: Ctx, input: UploadDocumentInput, options: RunOptions): Promise<Result<{ documentId: string; fileId: string }>> {
  if (input.bytes.byteLength === 0) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the file is empty', details: { field: 'file', reason: 'EMPTY' } } }
  if (input.bytes.byteLength > SUPPLIER_DOC_MAX_BYTES) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'the file is larger than 20 MB', details: { field: 'file', reason: 'TOO_LARGE' } } }
  const mime = sniffSupplierFile(input.bytes)
  if (!mime) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'only PDF, JPEG, PNG or WebP', details: { field: 'file', reason: 'TYPE_NOT_ALLOWED' } } }
  if (ctx.actor.type === 'SUPPLIER') {
    const scope = input.supplierId ? { kind: 'SUPPLIER' as const, key: input.supplierId } : { kind: 'APPLICATION' as const, key: input.applicationId ?? '' }
    if (!(await withinUploadLimit(ctx.organizationId, scope, ctx.now))) return { ok: false, error: { code: 'RATE_LIMITED', message: 'too many files this hour' } }
  }
  const storageKey = `${ctx.organizationId}/supplier-documents/${newId()}.${EXTENSION[mime]}`
  await putObject(storageKey, input.bytes, mime)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  return runCommand(
    ctx,
    uploadCommand,
    {
      supplierId: input.supplierId ?? null,
      applicationId: input.applicationId ?? null,
      documentTypeCode: input.documentTypeCode,
      docNumber: input.docNumber ?? null,
      issuer: input.issuer ?? null,
      scope: input.scope ?? null,
      issuedOn: input.issuedOn,
      expiresOn: input.expiresOn ?? null,
      file: { storageKey, fileName: input.fileName.slice(0, 200) || 'document', mimeType: mime, sizeBytes: input.bytes.byteLength, sha256 },
    },
    options,
  )
}

// ---------- supplierDocument.verify · .reject ----------

const VerifyInput = z.object({
  documentId: z.uuid(),
  expectedVersion: z.int().min(0),
  /** What the person read off the file and corrects in the same step (BR-SDOC ข้อ 03) */
  docNumber: z.string().trim().max(100).nullable().optional(),
  issuer: z.string().trim().max(200).nullable().optional(),
  scope: z.string().trim().max(200).nullable().optional(),
  issuedOn: ISO.optional(),
  expiresOn: ISO.nullable().optional(),
})

async function lockedDocument(tx: TenantTx, ctx: Ctx, documentId: string) {
  await lockRowsForUpdate(tx, 'SupplierDocument', ctx.organizationId, [documentId])
  return tx.supplierDocument.findUnique({ where: { id: documentId }, include: { documentType: true, file: { select: { scanStatus: true } } } })
}

const verifyCommand = defineCommand({
  name: 'supplierDocument.verify',
  capability: 'supplier.document.verify',
  input: VerifyInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ documentId: string; supersedes: string[] }>> {
    const doc = await lockedDocument(tx, ctx, input.documentId)
    if (!doc) return fail('NOT_FOUND', 'document not found')
    const who = await actingOn(tx, ctx, doc, 'supplier.document.verify')
    if ('ok' in who) return who
    if (doc.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the document changed since it was opened', { currentVersion: doc.version })
    const may = canVerify({ status: doc.status, scanStatus: doc.file.scanStatus === 'CLEAN' ? 'CLEAN' : doc.file.scanStatus === 'INFECTED' ? 'INFECTED' : 'PENDING' })
    if (!may.ok) return may.code === 'VALIDATION_FAILED' ? fail(may.reason === 'FILE_INFECTED' ? 'FILE_INFECTED' : 'FILE_NOT_SCANNED', 'the file is not clean', { reason: may.reason }) : fail('INVALID_STATE_TRANSITION', 'only a pending document is verified', { status: doc.status })
    const issuedOn = input.issuedOn ?? isoOf(doc.issuedOn)
    const stated = input.expiresOn !== undefined ? input.expiresOn : (doc.statedExpiresOn ? isoOf(doc.statedExpiresOn) : doc.documentType.validityDays === null ? isoOf(doc.expiresOn) : null)
    const dates = documentExpiry({ validityDays: doc.documentType.validityDays, reminderDaysBefore: doc.documentType.reminderDaysBefore }, { issuedOn, expiresOn: stated }, dateIn(ctx.now, DOCUMENT_TIMEZONE))
    if (!dates.ok) return fail('VALIDATION_FAILED', 'the dates of the document are not valid', { field: 'issuedOn', reason: dates.reason })
    const scope = input.scope !== undefined ? input.scope : doc.scope
    const scopeKey = doc.documentType.singleInstance ? '' : normalizeScope(scope)
    const ownerWhere = doc.supplierId ? { supplierId: doc.supplierId } : { applicationId: doc.applicationId }
    const verified = await tx.supplierDocument.findMany({ where: { ...ownerWhere, documentTypeCode: doc.documentTypeCode, status: 'VERIFIED', id: { not: doc.id } }, select: { id: true, scope: true }, orderBy: { id: 'asc' } })
    const targets = supersedeTargets({ singleInstance: doc.documentType.singleInstance }, { scope }, verified)
    const owner = { supplierId: doc.supplierId, applicationId: doc.applicationId }
    const events: EventDraft[] = []
    // the old copies leave first: one VERIFIED copy per owner, type and scope (the partial unique of S7-01)
    for (const id of targets.supersedes) {
      await tx.supplierDocument.update({ where: { id }, data: { status: 'SUPERSEDED', supersededById: doc.id, version: { increment: 1 } } })
      events.push({ type: 'supplier_document.superseded', aggregateType: 'SupplierDocument', aggregateId: id, data: { ...owner, documentTypeCode: doc.documentTypeCode, supersededById: doc.id } })
    }
    await tx.supplierDocument.update({
      where: { id: doc.id },
      data: {
        status: 'VERIFIED',
        verifiedById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null,
        verifiedAt: ctx.now,
        ...(input.docNumber !== undefined ? { docNumber: input.docNumber } : {}),
        ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
        scope,
        scopeKey,
        issuedOn: toDate(issuedOn),
        expiresOn: toDate(dates.expiresOn),
        statedExpiresOn: dates.statedExpiresOn ? toDate(dates.statedExpiresOn) : null,
        version: { increment: 1 },
      },
    })
    events.unshift({ type: 'supplier_document.verified', aggregateType: 'SupplierDocument', aggregateId: doc.id, data: { ...owner, documentTypeCode: doc.documentTypeCode, expiresOn: dates.expiresOn, supersedes: targets.supersedes } })
    return { ok: true, result: { documentId: doc.id, supersedes: targets.supersedes }, events }
  },
})

/** A rejected document's e-mail to the supplier's primary contact, or the application's (BR-SDOC ข้อ 03) */
async function rejectedNotice(tx: TenantTx, ctx: Ctx, doc: { id: string; supplierId: string | null; applicationId: string | null; documentType: { nameTh: string } }, reason: string) {
  const contact = await tx.supplierContact.findFirst({ where: { ...(doc.supplierId ? { supplierId: doc.supplierId } : { applicationId: doc.applicationId }), status: 'ACTIVE', isPrimary: true }, select: { id: true } })
  if (!contact) return { events: [] as EventDraft[], notifications: [] as NotificationDraft[], outbox: [] as OutboxDraft[] }
  return enqueueSupplierNotice(tx, ctx, { templateKey: PORTAL_SUPPLIER_TEMPLATES.documentRejected, contactId: contact.id, applicationId: doc.applicationId, subjectType: 'SupplierDocument', subjectId: doc.id, dedupeKey: `supplier.document_rejected:${doc.id}`, data: { typeName: doc.documentType.nameTh, reason } })
}

const rejectCommand = defineCommand({
  name: 'supplierDocument.reject',
  capability: 'supplier.document.verify',
  input: z.object({ documentId: z.uuid(), expectedVersion: z.int().min(0), reason: z.string().trim().min(3).max(500) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ documentId: string }>> {
    const doc = await lockedDocument(tx, ctx, input.documentId)
    if (!doc) return fail('NOT_FOUND', 'document not found')
    const who = await actingOn(tx, ctx, doc, 'supplier.document.verify')
    if ('ok' in who) return who
    if (doc.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the document changed since it was opened', { currentVersion: doc.version })
    if (doc.status !== 'PENDING') return fail('INVALID_STATE_TRANSITION', 'only a pending document is rejected', { status: doc.status })
    await tx.supplierDocument.update({ where: { id: doc.id }, data: { status: 'REJECTED', rejectReason: input.reason, version: { increment: 1 } } })
    const told = await rejectedNotice(tx, ctx, doc, input.reason)
    return {
      ok: true,
      result: { documentId: doc.id },
      events: [{ type: 'supplier_document.rejected', aggregateType: 'SupplierDocument', aggregateId: doc.id, data: { supplierId: doc.supplierId, applicationId: doc.applicationId, documentTypeCode: doc.documentTypeCode, reason: 'PERSON' } }, ...told.events],
      notifications: told.notifications,
      outbox: told.outbox,
    }
  },
})

// ---------- supplierDocument.requestDownload (POST · BR-SDOC ข้อ 05) ----------

const DOWNLOAD_TTL_SECONDS = 300

const downloadCommand = defineCommand({
  name: 'supplierDocument.requestDownload',
  capability: 'supplier.document.view',
  input: z.object({ documentId: z.uuid(), purpose: z.string().trim().min(3).max(200).default('ตรวจเอกสารผู้ขาย'), grantedBy: z.enum(['RISK_REVIEW']).optional() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ storageKey: string; fileName: string; mimeType: string }>> {
    const doc = await tx.supplierDocument.findUnique({ where: { id: input.documentId }, include: { documentType: { select: { sensitive: true } }, file: true } })
    if (!doc) return fail('NOT_FOUND', 'document not found')
    // S11's risk reviewer reads through its own right (grantedBy RISK_REVIEW), checked by S11's query before this call
    const who = input.grantedBy && ctx.actor.type === 'USER' ? ({ side: 'MEMBER' } as const) : await actingOn(tx, ctx, doc, 'supplier.document.view')
    if ('ok' in who) return who
    if (doc.file.scanStatus !== 'CLEAN') return fail(doc.file.scanStatus === 'INFECTED' ? 'FILE_INFECTED' : 'FILE_NOT_SCANNED', 'the file is not clean', { scanStatus: doc.file.scanStatus })
    if (doc.documentType.sensitive && who.side === 'MEMBER') {
      const sensitive = await authorize(tx, ctx, 'supplier.document.viewSensitive')
      if (!sensitive.ok) return { ok: false, error: sensitive.error }
      await tx.sensitiveAccessLog.create({ data: { organizationId: ctx.organizationId, memberId: (ctx.actor as { memberId: string }).memberId, subjectType: 'SupplierDocument', subjectId: doc.id, fields: ['file'], purpose: input.purpose, at: ctx.now } })
    }
    return {
      ok: true,
      result: { storageKey: doc.file.storageKey, fileName: doc.file.fileName, mimeType: doc.file.mimeType },
      events: [{ type: 'file.downloaded', aggregateType: 'File', aggregateId: doc.fileId, data: { fileId: doc.fileId, ...(input.grantedBy ? { grantedBy: input.grantedBy } : {}) } }],
    }
  },
})

/** A download URL of at most five minutes, after the checks and the log (never a GET that makes one) */
export async function requestSupplierDocumentDownload(ctx: Ctx, input: { documentId: string; purpose?: string; grantedBy?: 'RISK_REVIEW' }, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number }>> {
  const r = await runCommand(ctx, downloadCommand, input, options)
  if (!r.ok) return r
  return { ok: true, data: { url: await presignDownload(r.data.storageKey, { fileName: r.data.fileName, contentType: r.data.mimeType, inline: true }, DOWNLOAD_TTL_SECONDS), expiresInSeconds: DOWNLOAD_TTL_SECONDS } }
}

export const verifySupplierDocument = (ctx: Ctx, input: z.input<typeof VerifyInput>, options: RunOptions) => runCommand(ctx, verifyCommand, input, options)
export const rejectSupplierDocument = (ctx: Ctx, input: { documentId: string; expectedVersion: number; reason: string }, options: RunOptions) => runCommand(ctx, rejectCommand, input, options)

// ---------- the central scan (job file-scan) and S7's listener (job supplier-document-scanned) ----------

const fileScanCommand = defineCommand({
  name: 'file.scan',
  capability: 'system.supplierDocuments',
  input: z.object({ fileId: z.uuid(), result: z.enum(['CLEAN', 'INFECTED']), scanner: z.enum(['stub', 'live']) }),
  async execute(tx, input): Promise<CommandOutcome<{ result: 'CLEAN' | 'INFECTED' | 'SKIPPED' }>> {
    const claimed = await tx.fileObject.updateMany({ where: { id: input.fileId, scanStatus: 'PENDING' }, data: { scanStatus: input.result } })
    if (claimed.count === 0) return fail('INVALID_STATE_TRANSITION', 'the file was scanned already')
    const links = await tx.fileLink.findMany({ where: { fileId: input.fileId }, select: { kind: true } })
    return {
      ok: true,
      result: { result: input.result },
      events: [{ type: 'file.scanned', aggregateType: 'File', aggregateId: input.fileId, data: { fileId: input.fileId, result: input.result, linkKinds: [...new Set(links.map((l) => l.kind))].sort(), scanner: input.scanner } }],
    }
  },
})

/**
 * BR-PORTAL ข้อ 07: scans a file still PENDING — any kind of file — and says what it found in the event file.scanned with
 * the kinds it is linked as; a file no longer PENDING is left alone (a retry). The result for documents is each step's
 * own (supplierDocumentScanned below for SUPPLIER_DOC).
 */
export async function scanFile(organizationId: string, fileId: string, now: Date): Promise<'CLEAN' | 'INFECTED' | 'SKIPPED'> {
  const file = await fileToScan(organizationId, fileId)
  if (!file) return 'SKIPPED'
  const scanner = getScanner()
  const bytes = await readObject(file.storageKey)
  const result = await scanner.scan(bytes, file.sha256 ?? createHash('sha256').update(bytes).digest('hex'))
  const done = await runCommand(systemCtx(organizationId, now, 'file-scan'), fileScanCommand, { fileId, result, scanner: scanner.mode }, { idempotencyKey: `file-scan:scan:${fileId}` })
  return done.ok ? done.data.result : 'SKIPPED'
}

/** The file of a scan, while it waits for one */
async function fileToScan(organizationId: string, fileId: string) {
  const file = await forTenant(organizationId).fileObject.findUnique({ where: { id: fileId }, select: { storageKey: true, scanStatus: true, sha256: true } })
  return file && file.scanStatus === 'PENDING' ? file : null
}

const documentScannedCommand = defineCommand({
  name: 'supplierDocument.scanned',
  capability: 'system.supplierDocuments',
  input: z.object({ fileId: z.uuid(), result: z.enum(['CLEAN', 'INFECTED']) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ outcome: 'SCANNED' | 'REJECTED' }>> {
    const doc = await tx.supplierDocument.findFirst({ where: { fileId: input.fileId, status: 'PENDING' }, include: { documentType: { select: { nameTh: true } } } })
    if (!doc) return fail('INVALID_STATE_TRANSITION', 'no pending document of this file')
    const owner = { supplierId: doc.supplierId, applicationId: doc.applicationId }
    if (input.result === 'CLEAN') return { ok: true, result: { outcome: 'SCANNED' }, events: [{ type: 'supplier_document.scanned', aggregateType: 'SupplierDocument', aggregateId: doc.id, data: { ...owner, fileId: input.fileId } }] }
    await tx.supplierDocument.update({ where: { id: doc.id }, data: { status: 'REJECTED', rejectReason: 'FILE_INFECTED', version: { increment: 1 } } })
    const told = await rejectedNotice(tx, ctx, doc, 'ไฟล์ไม่ผ่านการตรวจความปลอดภัย / the file failed the security check')
    return {
      ok: true,
      result: { outcome: 'REJECTED' },
      events: [{ type: 'supplier_document.rejected', aggregateType: 'SupplierDocument', aggregateId: doc.id, data: { ...owner, documentTypeCode: doc.documentTypeCode, reason: 'INFECTED' } }, ...told.events],
      notifications: told.notifications,
      outbox: told.outbox,
    }
  },
})

/** S7's listener of file.scanned: a PENDING document of a clean file is scanned; of an infected one, REJECTED and told */
export async function supplierDocumentScanned(organizationId: string, fileId: string, result: 'CLEAN' | 'INFECTED', now: Date): Promise<'SCANNED' | 'REJECTED' | 'SKIPPED'> {
  const done = await runCommand(systemCtx(organizationId, now, 'supplier-document-scanned'), documentScannedCommand, { fileId, result }, { idempotencyKey: `supplier-document-scanned:mark:${fileId}` })
  return done.ok ? done.data.outcome : 'SKIPPED'
}

// ---------- the daily expiry (job supplier-document-expiry · BR-SDOC ข้อ 04) ----------

/** remindOn of a stored document: max(expiresOn − reminderDaysBefore, issuedOn) (BR-SDOC ข้อ 02) */
export function remindOnOf(doc: { readonly issuedOn: Date; readonly expiresOn: Date }, reminderDaysBefore: number): IsoDate {
  const r = new Date(doc.expiresOn.getTime() - reminderDaysBefore * 24 * MS_PER_HOUR)
  return isoOf(r < doc.issuedOn ? doc.issuedOn : r)
}

const expiryCommand = defineCommand({
  name: 'supplierDocument.expiry',
  capability: 'system.supplierDocuments',
  input: z.object({ documentId: z.uuid(), action: z.enum(['EXPIRE', 'REMIND']), today: ISO }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ done: true }>> {
    await lockRowsForUpdate(tx, 'SupplierDocument', ctx.organizationId, [input.documentId])
    const doc = await tx.supplierDocument.findUnique({ where: { id: input.documentId }, include: { documentType: { select: { nameTh: true, reminderDaysBefore: true } } } })
    if (!doc || doc.status !== 'VERIFIED') return fail('INVALID_STATE_TRANSITION', 'the document is not verified any more')
    const owner = { supplierId: doc.supplierId, applicationId: doc.applicationId }
    const expiresOn = isoOf(doc.expiresOn)
    if (input.action === 'EXPIRE') {
      await tx.supplierDocument.update({ where: { id: doc.id }, data: { status: 'EXPIRED', expiredAt: ctx.now, version: { increment: 1 } } })
      return { ok: true, result: { done: true }, events: [{ type: 'supplier_document.expired', aggregateType: 'SupplierDocument', aggregateId: doc.id, data: { ...owner, documentTypeCode: doc.documentTypeCode, expiresOn } }] }
    }
    if (doc.reminderSentAt) return fail('INVALID_STATE_TRANSITION', 'reminded already')
    await tx.supplierDocument.update({ where: { id: doc.id }, data: { reminderSentAt: ctx.now } })
    const remindOn = remindOnOf(doc, doc.documentType.reminderDaysBefore)
    const contact = await tx.supplierContact.findFirst({ where: { ...(doc.supplierId ? { supplierId: doc.supplierId } : { applicationId: doc.applicationId }), status: 'ACTIVE', isPrimary: true }, select: { id: true } })
    const notice = contact
      ? await enqueueSupplierNotice(tx, ctx, { templateKey: PORTAL_SUPPLIER_TEMPLATES.documentExpiring, contactId: contact.id, applicationId: doc.applicationId, subjectType: 'SupplierDocument', subjectId: doc.id, dedupeKey: `supplier-document-expiry:${input.today}:${doc.id}`, data: { typeName: doc.documentType.nameTh, expiresOn } })
      : { events: [] as EventDraft[], notifications: [] as NotificationDraft[], outbox: [] as OutboxDraft[] }
    const procurement = await tx.roleAssignment.findMany({ where: { role: 'PROCUREMENT', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true }, distinct: ['memberId'] })
    const digest: NotificationDraft[] = procurement.map((p) => ({
      recipientMemberId: p.memberId,
      templateKey: 'supplier.documents_expiring_digest',
      data: { documentId: doc.id, supplierId: doc.supplierId, typeName: doc.documentType.nameTh, expiresOn },
      urgency: 'DIGEST' as const,
      dedupeKey: `supplier.documents_expiring_digest:${doc.id}:${p.memberId}`,
      subjectType: 'SupplierDocument',
      subjectId: doc.id,
    }))
    return {
      ok: true,
      result: { done: true },
      events: [{ type: 'supplier_document.reminder_sent', aggregateType: 'SupplierDocument', aggregateId: doc.id, data: { ...owner, documentTypeCode: doc.documentTypeCode, remindOn, expiresOn } }, ...notice.events],
      notifications: [...digest, ...notice.notifications],
      outbox: notice.outbox,
    }
  },
})

/**
 * One organization's run at 07:00 Bangkok: every VERIFIED document past its remindOn and not yet reminded gets one e-mail
 * to its primary contact and one digest notice to PROCUREMENT; every one past its expiry turns EXPIRED. The date of
 * `now` decides (documentStatus); the date is the idempotency key, so a retry repeats nothing.
 */
export async function runDocumentExpiry(organizationId: string, now: Date): Promise<{ reminded: number; expired: number }> {
  const today = dateIn(now, DOCUMENT_TIMEZONE)
  const docs = await forTenant(organizationId).supplierDocument.findMany({ where: { status: 'VERIFIED' }, include: { documentType: { select: { reminderDaysBefore: true } } }, orderBy: { id: 'asc' } })
  const ctx = systemCtx(organizationId, now, 'supplier-document-expiry')
  let reminded = 0
  let expired = 0
  for (const doc of docs) {
    const state = documentStatus({ expiresOn: isoOf(doc.expiresOn), remindOn: remindOnOf(doc, doc.documentType.reminderDaysBefore) }, now, DOCUMENT_TIMEZONE)
    const action = state.status === 'EXPIRED' ? 'EXPIRE' : state.reminderDue && !doc.reminderSentAt ? 'REMIND' : null
    if (!action) continue
    const done = await runCommand(ctx, expiryCommand, { documentId: doc.id, action, today }, { idempotencyKey: `supplier-document-expiry:${today}:${doc.id}:${action}` })
    if (done.ok && action === 'EXPIRE') expired++
    if (done.ok && action === 'REMIND') reminded++
  }
  return { reminded, expired }
}

/** The 07:00 run over every organization with SUPPLIER */
export async function runAllDocumentExpiry(now: Date): Promise<{ reminded: number; expired: number }> {
  const total = { reminded: 0, expired: 0 }
  for (const organizationId of await organizationsWithSupplier()) {
    const r = await runDocumentExpiry(organizationId, now)
    total.reminded += r.reminded
    total.expired += r.expired
  }
  return total
}

// ---------- the documents of a supplier, by type (BR-SDOC ข้อ 06) ----------

export type DocumentState = 'OK' | 'EXPIRING' | 'EXPIRED' | 'MISSING' | 'PENDING'

export interface SupplierDocumentStatusRow {
  readonly documentTypeCode: string
  readonly required: boolean
  readonly scope: string | null
  readonly state: DocumentState
  readonly expiresOn: string | null
}

/**
 * Inside a caller's transaction, no capability checked (S10 S11 services and jobs): per required type of the supplier's
 * payee type, and per type it has a copy of, the state on the date of `now` — not the status column only, so the answer
 * is the same before and after the 07:00 job.
 */
export async function supplierDocumentStatusInTx(tx: TenantTx, organizationId: string, supplierId: string, now: Date): Promise<{ readonly rows: SupplierDocumentStatusRow[]; readonly requiredDocumentsOk: boolean }> {
  void organizationId
  const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: supplierId }, select: { payeeType: true } })
  const types = await tx.supplierDocumentType.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  const docs = await tx.supplierDocument.findMany({ where: { supplierId, status: { in: ['PENDING', 'VERIFIED', 'EXPIRED'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const rows: SupplierDocumentStatusRow[] = []
  for (const type of types) {
    const required = type.required && type.appliesTo.includes(supplier.payeeType)
    const mine = docs.filter((d) => d.documentTypeCode === type.code)
    if (!required && mine.length === 0) continue
    const scopes = type.singleInstance ? [''] : [...new Set(mine.map((d) => d.scopeKey))]
    for (const key of scopes.length ? scopes : ['']) {
      const copies = mine.filter((d) => type.singleInstance || d.scopeKey === key)
      const live = copies.find((d) => d.status === 'VERIFIED' || d.status === 'EXPIRED')
      let state: DocumentState = 'MISSING'
      let expiresOn: string | null = null
      if (live) {
        expiresOn = isoOf(live.expiresOn)
        const s = documentStatus({ expiresOn, remindOn: remindOnOf(live, type.reminderDaysBefore) }, now, DOCUMENT_TIMEZONE)
        state = s.status === 'EXPIRED' || live.status === 'EXPIRED' ? 'EXPIRED' : s.reminderDue ? 'EXPIRING' : 'OK'
      } else if (copies.some((d) => d.status === 'PENDING')) state = 'PENDING'
      rows.push({ documentTypeCode: type.code, required, scope: copies[0]?.scope ?? null, state, expiresOn })
    }
  }
  return { rows, requiredDocumentsOk: rows.filter((r) => r.required).every((r) => r.state === 'OK' || r.state === 'EXPIRING') }
}

/** The same for screens: supplier.document.view, or the supplier's own contact on the portal */
export async function supplierDocumentStatus(ctx: Ctx, supplierId: string): Promise<Result<{ readonly rows: SupplierDocumentStatusRow[]; readonly requiredDocumentsOk: boolean }>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await actingOn(tx, ctx, { supplierId, applicationId: null }, 'supplier.document.view')
    if ('ok' in who) return who
    return { ok: true as const, data: await supplierDocumentStatusInTx(tx, ctx.organizationId, supplierId, ctx.now) }
  })
}

// ---------- admin.supplierDocumentTypes.upsert · .deactivate (ORG_ADMIN · BR-SDOC ข้อ 01) ----------

const TypeInput = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
    nameTh: z.string().trim().min(1).max(200),
    nameEn: z.string().trim().min(1).max(200),
    appliesTo: z.array(z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN'])).min(1),
    required: z.boolean(),
    validityDays: z.int().min(1).max(SUPPLIER_DOC_MAX_VALIDITY_DAYS).nullable(),
    reminderDaysBefore: z.int().min(0).max(365),
    sensitive: z.boolean().default(false),
    singleInstance: z.boolean().default(true),
    aiReadable: z.boolean().default(false),
    sortOrder: z.int().min(0).max(999).default(0),
    /** BR-SDOC ข้อ 03: a type that needs no person to verify is not supported until an OQ says how */
    requiresVerification: z.literal(true).default(true),
  })
  .strict()

const upsertTypeCommand = defineCommand({
  name: 'admin.supplierDocumentTypes.upsert',
  capability: 'admin.supplierDocumentTypes',
  input: TypeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ code: string }>> {
    const on = await requireModule(ctx, 'SUPPLIER', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const may = await authorize(tx, ctx, 'admin.supplierDocumentTypes')
    if (!may.ok) return { ok: false, error: may.error }
    const existing = await tx.supplierDocumentType.findFirst({ where: { code: input.code } })
    const fields = { nameTh: input.nameTh, nameEn: input.nameEn, appliesTo: input.appliesTo, required: input.required, validityDays: input.validityDays, reminderDaysBefore: input.reminderDaysBefore, sensitive: input.sensitive, singleInstance: input.singleInstance, aiReadable: input.aiReadable, sortOrder: input.sortOrder }
    const changed = existing ? Object.keys(fields).filter((k) => JSON.stringify(fields[k as keyof typeof fields]) !== JSON.stringify(existing[k as keyof typeof existing])) : Object.keys(fields)
    if (existing && changed.length === 0 && existing.active) return fail('VALIDATION_FAILED', 'nothing changed', { reason: 'NO_CHANGE' })
    const id = existing
      ? (await tx.supplierDocumentType.update({ where: { id: existing.id }, data: { ...fields, active: true, version: { increment: 1 } }, select: { id: true } })).id
      : (await tx.supplierDocumentType.create({ data: { organizationId: ctx.organizationId, code: input.code, ...fields }, select: { id: true } })).id
    return { ok: true, result: { code: input.code }, events: [{ type: 'supplier_document_type.updated', aggregateType: 'SupplierDocumentType', aggregateId: id, data: { code: input.code, created: !existing, active: true, changed } }] }
  },
})

const deactivateTypeCommand = defineCommand({
  name: 'admin.supplierDocumentTypes.deactivate',
  capability: 'admin.supplierDocumentTypes',
  input: z.object({ code: z.string().min(1).max(40) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ code: string }>> {
    const on = await requireModule(ctx, 'SUPPLIER', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const may = await authorize(tx, ctx, 'admin.supplierDocumentTypes')
    if (!may.ok) return { ok: false, error: may.error }
    const existing = await tx.supplierDocumentType.findFirst({ where: { code: input.code } })
    if (!existing) return fail('NOT_FOUND', 'document type not found')
    if (!existing.active) return fail('INVALID_STATE_TRANSITION', 'the type is closed already')
    await tx.supplierDocumentType.update({ where: { id: existing.id }, data: { active: false, version: { increment: 1 } } })
    return { ok: true, result: { code: input.code }, events: [{ type: 'supplier_document_type.updated', aggregateType: 'SupplierDocumentType', aggregateId: existing.id, data: { code: input.code, created: false, active: false, changed: ['active'] } }] }
  },
})

export const upsertSupplierDocumentType = (ctx: Ctx, input: z.input<typeof TypeInput>, options: RunOptions) => runCommand(ctx, upsertTypeCommand, input, options)
export const deactivateSupplierDocumentType = (ctx: Ctx, input: { code: string }, options: RunOptions) => runCommand(ctx, deactivateTypeCommand, input, options)

