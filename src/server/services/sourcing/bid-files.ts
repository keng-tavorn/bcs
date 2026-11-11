import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import { deleteObject, presignDownload, putObject } from '@/integrations/storage'
import { BID_FILES_MAX, MS_PER_HOUR, SUPPLIER_DOC_MAX_BYTES } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { PORTAL_PRIVACY_NOTICE_VERSION, PORTAL_UPLOADS_PER_HOUR } from '@/lib/portal-limits'
import { systemCtx, type Ctx } from '@/server/context'
import { countPortalScopeHit } from '@/server/db/portal'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { SOURCING_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-sourcing'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { sniffSupplierFile, type SupplierFileMime } from '../suppliers/documents'
import { biddingSupplier, bidOf, contactInvite, MAY_BID, open } from './bids'
import { orgCodeOf, portalLoginUrl } from './invites'
import { lockedRfx } from './rfx'

// The files of a bid from the portal (S10-07 · BR-RFX-07 · BR-PORTAL-07): the supplier's quotation, catalogue or an
// RFI's answer as PDF, JPEG, PNG or WebP by their bytes, at most 20 MB and BID_FILES_MAX a bid, kept private and PENDING
// until S7's central scan (job file-scan on file.uploaded) calls them CLEAN; an INFECTED one is taken off the bid (the
// file kept for the audit) and the contact told (bidFileScanned, job bid-file-scanned on file.scanned). Attached and
// removed while the RFx is open; a file never changes the bid's status or version (a sent bid stays sent). The contact
// opens the RFx's own files (RFX_DOC) and its bid's files in any state but INFECTED, by a five-minute link from a POST.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false
const EXTENSION: Record<SupplierFileMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
const DOWNLOAD_TTL_SECONDS = 300

/** The contact's own bid on an RFx open for bids, locked; refusals as the bid's commands give them */
async function openBidOfContact(tx: TenantTx, ctx: Ctx, rfxEventId: string, create: boolean) {
  const on = await requireModule(ctx, 'SOURCING', tx)
  if (!on.ok) return { ok: false as const, error: on.error }
  const rfx = await lockedRfx(tx, ctx, rfxEventId)
  const invite = rfx ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.bid') : fail('NOT_FOUND', 'RFx not found')
  if (isFail(invite)) return invite
  if (!open(rfx!, ctx.now)) return fail('RFX_CLOSED', 'the RFx is closed for bids', { closesAt: rfx!.closesAt?.toISOString() ?? null })
  const supplier = await biddingSupplier(tx, invite.supplierId)
  if (isFail(supplier)) return supplier
  if (!MAY_BID.has(invite.status)) return fail('INVALID_STATE_TRANSITION', `the invite takes no files while ${invite.status}`, { from: invite.status, command: 'portal.rfx.bid' })
  let bid: Awaited<ReturnType<typeof bidOf>>
  if (create) bid = await bidOf(tx, ctx, rfx!.id, invite.id, supplier.id)
  else {
    const found = await tx.bid.findFirst({ where: { rfxEventId: rfx!.id, supplierId: supplier.id }, select: { id: true } })
    if (!found) return fail('NOT_FOUND', 'no bid of the supplier')
    await lockRowsForUpdate(tx, 'Bid', ctx.organizationId, [found.id])
    bid = await tx.bid.findUniqueOrThrow({ where: { id: found.id } })
  }
  if (bid.status === 'DISQUALIFIED') return fail('INVALID_STATE_TRANSITION', 'the bid is disqualified', { from: bid.status, command: 'portal.rfx.bid' })
  return { ok: true as const, rfx: rfx!, bid }
}

// ---------- bid.attachFile (the contact) ----------

const AttachInput = z.strictObject({
  rfxEventId: z.uuid(),
  file: z.strictObject({ storageKey: z.string().min(1), fileName: z.string().min(1).max(200), mimeType: z.string(), sizeBytes: z.int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
})

const attachCommand = defineCommand({
  name: 'bid.attachFile',
  capability: 'portal.rfx.bid',
  input: AttachInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string; fileId: string }>> {
    // BR-PORTAL ข้อ 08: nothing is uploaded before the current privacy notice is accepted
    if (ctx.actor.type === 'SUPPLIER') {
      const contact = await tx.supplierContact.findUnique({ where: { id: ctx.actor.supplierContactId }, select: { privacyNoticeVersion: true } })
      if (contact?.privacyNoticeVersion !== PORTAL_PRIVACY_NOTICE_VERSION) return fail('PRIVACY_NOTICE_OUTDATED', 'the current privacy notice is not accepted yet', { version: PORTAL_PRIVACY_NOTICE_VERSION })
    }
    const got = await openBidOfContact(tx, ctx, input.rfxEventId, true)
    if (!got.ok) return got
    const { rfx, bid } = got
    const linked = await tx.fileLink.count({ where: { subjectType: 'Bid', subjectId: bid.id, kind: 'BID_DOC' } })
    if (linked >= BID_FILES_MAX) return fail('VALIDATION_FAILED', `at most ${BID_FILES_MAX} files a bid`, { field: 'file', reason: 'TOO_MANY_FILES', max: BID_FILES_MAX })
    const fileId = newId()
    await tx.fileObject.create({
      data: { id: fileId, organizationId: ctx.organizationId, storageKey: input.file.storageKey, fileName: input.file.fileName, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes, sha256: input.file.sha256, status: 'AVAILABLE', uploadedById: null, scanStatus: 'PENDING' },
    })
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId, subjectType: 'Bid', subjectId: bid.id, kind: 'BID_DOC' } })
    return {
      ok: true,
      result: { bidId: bid.id, fileId },
      events: [
        { type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.file.mimeType, sizeBytes: input.file.sizeBytes } },
        { type: 'bid.file_attached', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: rfx.id, fileId } },
      ],
    }
  },
})

export interface UploadBidFileInput {
  readonly rfxEventId: string
  readonly fileName: string
  readonly bytes: Uint8Array
}

/** One file of the contact's bid; the bytes are checked before anything is stored, and a refused upload keeps nothing */
export async function uploadBidFile(ctx: Ctx, input: UploadBidFileInput, options: RunOptions): Promise<Result<{ bidId: string; fileId: string }>> {
  if (input.bytes.byteLength === 0) return fail('VALIDATION_FAILED', 'the file is empty', { field: 'file', reason: 'EMPTY' })
  if (input.bytes.byteLength > SUPPLIER_DOC_MAX_BYTES) return fail('VALIDATION_FAILED', 'the file is larger than 20 MB', { field: 'file', reason: 'TOO_LARGE' })
  const mime = sniffSupplierFile(input.bytes)
  if (!mime) return fail('VALIDATION_FAILED', 'only PDF, JPEG, PNG or WebP', { field: 'file', reason: 'TYPE_NOT_ALLOWED' })
  if (ctx.actor.type === 'SUPPLIER' && ctx.actor.supplierId) {
    // the portal's upload bucket of S7 (BR-PORTAL ข้อ 07): documents, evidence and bid files count together per supplier
    const windowStart = new Date(Math.floor(ctx.now.getTime() / MS_PER_HOUR) * MS_PER_HOUR)
    if ((await countPortalScopeHit(ctx.organizationId, { kind: 'SUPPLIER', key: ctx.actor.supplierId }, 'UPLOAD', windowStart)) > PORTAL_UPLOADS_PER_HOUR) return fail('RATE_LIMITED', 'too many files this hour')
  }
  const storageKey = `${ctx.organizationId}/bid-docs/${newId()}.${EXTENSION[mime]}`
  await putObject(storageKey, input.bytes, mime)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const recorded = await runCommand(
    ctx,
    attachCommand,
    { rfxEventId: input.rfxEventId, file: { storageKey, fileName: input.fileName.slice(0, 200) || 'file', mimeType: mime, sizeBytes: input.bytes.byteLength, sha256 } },
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

// ---------- bid.removeFile (the contact) ----------

const RemoveInput = z.strictObject({ rfxEventId: z.uuid(), fileId: z.uuid() })

const removeCommand = defineCommand({
  name: 'bid.removeFile',
  capability: 'portal.rfx.bid',
  input: RemoveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ bidId: string }>> {
    const got = await openBidOfContact(tx, ctx, input.rfxEventId, false)
    if (!got.ok) return got
    const link = await tx.fileLink.findFirst({ where: { fileId: input.fileId, subjectType: 'Bid', subjectId: got.bid.id, kind: 'BID_DOC' }, select: { id: true } })
    if (!link) return fail('NOT_FOUND', 'no such file on the bid')
    // the link goes, the file stays for the audit
    await tx.fileLink.delete({ where: { id: link.id } })
    return { ok: true, result: { bidId: got.bid.id }, events: [{ type: 'bid.file_removed', aggregateType: 'Bid', aggregateId: got.bid.id, data: { rfxEventId: got.rfx.id, fileId: input.fileId } }] }
  },
})

export const removeBidFile = (ctx: Ctx, input: z.input<typeof RemoveInput>, opts: RunOptions) => runCommand(ctx, removeCommand, input, opts)

// ---------- portal.rfx.file: the contact opens a file of its RFx or of its bid ----------

const DownloadInput = z.strictObject({ rfxEventId: z.uuid(), fileId: z.uuid() })

const downloadCommand = defineCommand({
  name: 'portal.rfx.file',
  capability: 'portal.rfx.view',
  input: DownloadInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ storageKey: string; fileName: string; mimeType: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const rfx = await tx.rfxEvent.findUnique({ where: { id: input.rfxEventId }, select: { id: true, status: true } })
    // an RFx the contact is not invited to, or still a draft, does not exist for them (INV-RFX-01)
    const invite = rfx && rfx.status !== 'DRAFT' ? await contactInvite(tx, ctx, rfx.id, 'portal.rfx.view') : fail('NOT_FOUND', 'RFx not found')
    if (isFail(invite)) return invite
    const bid = invite.supplierId ? await tx.bid.findFirst({ where: { rfxEventId: rfx!.id, supplierId: invite.supplierId }, select: { id: true } }) : null
    const link = await tx.fileLink.findFirst({
      where: { fileId: input.fileId, OR: [{ kind: 'RFX_DOC', subjectType: 'RfxEvent', subjectId: rfx!.id }, ...(bid ? [{ kind: 'BID_DOC' as const, subjectType: 'Bid', subjectId: bid.id }] : [])] },
      select: { file: { select: { storageKey: true, fileName: true, mimeType: true, scanStatus: true } } },
    })
    if (!link) return fail('NOT_FOUND', 'no such file of the RFx or of the bid')
    // BR-PORTAL ข้อ 07: the supplier opens its files in any state but INFECTED
    if (link.file.scanStatus === 'INFECTED') return fail('FILE_INFECTED', 'the file did not pass the scan', { scanStatus: link.file.scanStatus })
    return {
      ok: true,
      result: { storageKey: link.file.storageKey, fileName: link.file.fileName, mimeType: link.file.mimeType },
      events: [{ type: 'file.downloaded', aggregateType: 'File', aggregateId: input.fileId, data: { fileId: input.fileId } }],
    }
  },
})

/** A five-minute link to one file of the contact's RFx or bid, after the checks and the event (a POST, never a GET) */
export async function requestPortalRfxFile(ctx: Ctx, input: z.input<typeof DownloadInput>, options: RunOptions): Promise<Result<{ url: string; expiresInSeconds: number }>> {
  const r = await runCommand(ctx, downloadCommand, input, options)
  if (!r.ok) return r
  return { ok: true, data: { url: await presignDownload(r.data.storageKey, { fileName: r.data.fileName, contentType: r.data.mimeType, inline: true }, DOWNLOAD_TTL_SECONDS), expiresInSeconds: DOWNLOAD_TTL_SECONDS } }
}

// ---------- the scan's answer for a bid's file (job bid-file-scanned · BR-PORTAL-07) ----------

const scannedCommand = defineCommand({
  name: 'bid.fileScanned',
  capability: 'system.sourcing',
  input: z.strictObject({ fileId: z.uuid() }),
  async execute(tx: TenantTx, input, ctx): Promise<CommandOutcome<{ outcome: 'REJECTED' }>> {
    const link = await tx.fileLink.findFirst({ where: { fileId: input.fileId, kind: 'BID_DOC', subjectType: 'Bid' }, select: { id: true, subjectId: true, file: { select: { fileName: true } } } })
    if (!link) return fail('INVALID_STATE_TRANSITION', 'no bid link of this file')
    const bid = await tx.bid.findUnique({ where: { id: link.subjectId }, select: { id: true, supplierId: true, rfxEventId: true, invite: { select: { contactId: true } }, rfxEvent: { select: { number: true, title: true, titleEn: true } } } })
    if (!bid) return fail('NOT_FOUND', 'bid not found')
    // the link goes, the file stays for the audit; the bid keeps its state
    await tx.fileLink.delete({ where: { id: link.id } })
    const told = await enqueueSupplierNotice(tx, ctx, {
      templateKey: SOURCING_SUPPLIER_TEMPLATES.fileRejected,
      supplierId: bid.supplierId,
      contactId: bid.invite.contactId,
      subjectType: 'Bid',
      subjectId: bid.id,
      dedupeKey: `rfx.file_rejected:${input.fileId}`,
      data: { number: bid.rfxEvent.number, title: bid.rfxEvent.title, titleEn: bid.rfxEvent.titleEn, fileName: link.file.fileName, loginUrl: portalLoginUrl(await orgCodeOf(tx, ctx.organizationId)) },
    })
    return {
      ok: true,
      result: { outcome: 'REJECTED' },
      events: [{ type: 'bid.file_rejected', aggregateType: 'Bid', aggregateId: bid.id, data: { rfxEventId: bid.rfxEventId, fileId: input.fileId } }, ...told.events],
      notifications: told.notifications,
      outbox: told.outbox,
    }
  },
})

/** The listener of file.scanned for BID_DOC: INFECTED → the file taken off the bid and the contact told; CLEAN → nothing */
export async function bidFileScanned(organizationId: string, fileId: string, result: 'CLEAN' | 'INFECTED', now: Date): Promise<'REJECTED' | 'SKIPPED'> {
  if (result === 'CLEAN') return 'SKIPPED'
  const done = await runCommand(systemCtx(organizationId, now, 'bid-file-scanned'), scannedCommand, { fileId }, { idempotencyKey: `bid-file-scanned:${fileId}` })
  return done.ok ? done.data.outcome : 'SKIPPED'
}
