import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { deleteObject, headObject, presignDownload, presignUpload, PRESIGN_TTL_SECONDS, readHead, sha256Of } from '@/integrations/storage'
import { systemClock } from '@/lib/clock'
import { FILE_NAME_INPUT_MAX, MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import '../exports/file-policy'
import { ALLOWED_FILE_TYPES, checkDeclaredUpload, cleanFileName, contentMatchesType, FILE_NAME_MAX, GENERATED_FILE_TYPES, isAllowedMimeType, isGeneratedMimeType, SNIFF_BYTES, type AllowedMimeType } from '@/lib/file-types'
import { newId } from '@/lib/ids'
import { loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { fileSubjectPolicy } from './policies'
// Document types register who may download their files when the service loads (FR-PLT-004 AC2)
import './request-policy'
import './receipt-policy'

// Upload and download through presigned URLs (FR-PLT-004, NFR-SEC-08).
// 1. requestUpload checks the declared type and size and returns a PUT URL bound to that type and exact length,
//    plus a signed ticket; nothing is stored yet.
// 2. The browser PUTs the bytes straight to the private bucket.
// 3. completeUpload reads the object back: size, magic bytes and sha256; a mismatch deletes the object. Only then
//    is the FileObject recorded, with event file.uploaded.
// 4. getDownloadUrl gives a GET URL valid for at most 5 minutes, after checking the document the file is attached
//    to (an unattached file: only the person who uploaded it).
// Tickets and URLs expire on real time (security clock), not the business clock.

const TICKET_TTL_MS = 15 * MS_PER_MINUTE

export type FileRefusalReason = 'TYPE_NOT_ALLOWED' | 'TOO_LARGE' | 'EMPTY' | 'CONTENT_MISMATCH' | 'NOT_UPLOADED' | 'TICKET_INVALID'

const refuse = (reason: FileRefusalReason, field = 'file') => err('VALIDATION_FAILED', `upload refused: ${reason}`, { field, reason })

// ---------- signed upload ticket ----------

interface UploadTicket {
  readonly org: string
  readonly member: string
  readonly key: string
  readonly name: string
  readonly mime: AllowedMimeType
  readonly size: number
  readonly exp: number
}

function ticketMac(payload: string): Buffer {
  const secret = createHmac('sha256', getEnv().ENCRYPTION_KEY).update('bcs-upload-ticket-v1').digest()
  return createHmac('sha256', secret).update(payload).digest()
}

function signTicket(ticket: UploadTicket): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url')
  return `${payload}.${ticketMac(payload).toString('base64url')}`
}

function readTicket(token: string, ctx: Ctx, now: Date): UploadTicket | null {
  const [payload, mac] = token.split('.')
  if (!payload || !mac) return null
  const expected = ticketMac(payload)
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadTicket
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (ticket.org !== ctx.organizationId || ticket.member !== memberId || ticket.exp <= now.getTime()) return null
  return ticket
}

async function activeMemberId(ctx: Ctx): Promise<string | null> {
  const principal = await forTenant(ctx.organizationId).$transaction((tx) => loadPrincipal(tx, ctx))
  return principal.kind === 'member' ? principal.memberId : null
}

// ---------- 1. request ----------

const RequestUploadInput = z.object({ fileName: z.string().min(1).max(FILE_NAME_INPUT_MAX), mimeType: z.string(), sizeBytes: z.number() })

export async function requestUpload(ctx: Ctx, input: z.input<typeof RequestUploadInput>): Promise<Result<{ uploadUrl: string; ticket: string }>> {
  const parsed = RequestUploadInput.safeParse(input)
  if (!parsed.success) return err('VALIDATION_FAILED', 'invalid input', { field: parsed.error.issues[0]?.path.join('.') || 'file' })
  const memberId = await activeMemberId(ctx)
  if (!memberId) return err('FORBIDDEN', 'members only')
  const refusal = checkDeclaredUpload(parsed.data.mimeType, parsed.data.sizeBytes)
  if (refusal) return refuse(refusal)
  const mime = parsed.data.mimeType as AllowedMimeType
  const key = `org/${ctx.organizationId}/${newId()}`
  const uploadUrl = await presignUpload(key, mime, parsed.data.sizeBytes)
  const ticket = signTicket({
    org: ctx.organizationId,
    member: memberId,
    key,
    name: cleanFileName(parsed.data.fileName),
    mime,
    size: parsed.data.sizeBytes,
    exp: systemClock.now().getTime() + TICKET_TTL_MS,
  })
  return ok({ uploadUrl, ticket })
}

// ---------- 3. complete ----------

const RecordFileInput = z.object({
  key: z.string().min(1),
  fileName: z.string().min(1).max(FILE_NAME_MAX),
  mimeType: z.string().refine(isAllowedMimeType),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})

const recordFileCommand = defineCommand({
  name: 'file.record_upload',
  capability: 'request.create',
  input: RecordFileInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ fileId: string; fileName: string }>> {
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member') return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const fileId = newId()
    await tx.fileObject.create({
      data: {
        id: fileId,
        organizationId: ctx.organizationId,
        storageKey: input.key,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
        status: 'AVAILABLE',
        uploadedById: principal.memberId,
        // Files from members are internal; files from outside (supplier portal, tier 2) are scanned (NFR-SEC-08)
        scanStatus: 'NOT_REQUIRED',
      },
    })
    return {
      ok: true,
      result: { fileId, fileName: input.fileName },
      events: [{ type: 'file.uploaded', aggregateType: 'File', aggregateId: fileId, data: { fileId, mimeType: input.mimeType, sizeBytes: input.sizeBytes } }],
    }
  },
})

export async function completeUpload(
  ctx: Ctx,
  input: { ticket: string },
  options: Omit<RunOptions, 'idempotencyKey'> = {},
): Promise<Result<{ fileId: string; fileName: string }>> {
  const ticket = readTicket(String(input.ticket ?? ''), ctx, systemClock.now())
  if (!ticket) return refuse('TICKET_INVALID', 'ticket')
  const head = await headObject(ticket.key)
  if (!head) return refuse('NOT_UPLOADED')
  const firstBytes = await readHead(ticket.key, SNIFF_BYTES)
  if (head.sizeBytes !== ticket.size || !contentMatchesType(firstBytes, ticket.mime)) {
    await deleteObject(ticket.key)
    return refuse('CONTENT_MISMATCH')
  }
  const sha256 = await sha256Of(ticket.key)
  return runCommand(
    ctx,
    recordFileCommand,
    { key: ticket.key, fileName: ticket.name, mimeType: ticket.mime, sizeBytes: ticket.size, sha256 },
    { ...options, idempotencyKey: `upload:${ticket.key}` },
  )
}

// ---------- 4. download ----------

export async function getDownloadUrl(ctx: Ctx, input: { fileId: string }): Promise<Result<{ url: string; expiresInSeconds: number }>> {
  if (!z.uuid().safeParse(input.fileId).success) return err('NOT_FOUND', 'file not found')
  const decision = await forTenant(ctx.organizationId).$transaction(async (tx) => {
    const file = await tx.fileObject.findUnique({ where: { id: input.fileId } })
    if (!file || file.status !== 'AVAILABLE' || !(isAllowedMimeType(file.mimeType) || isGeneratedMimeType(file.mimeType))) return { kind: 'missing' as const }
    const principal = await loadPrincipal(tx, ctx)
    if (principal.kind !== 'member') return { kind: 'denied' as const }
    const links = await tx.fileLink.findMany({ where: { fileId: file.id }, select: { subjectType: true, subjectId: true } })
    let allowed = links.length === 0 && file.uploadedById === principal.memberId
    for (const link of links) {
      if (allowed) break
      const policy = fileSubjectPolicy(link.subjectType)
      allowed = policy ? await policy(tx, ctx, principal, link.subjectId) : false
    }
    return allowed ? { kind: 'allowed' as const, file } : { kind: 'denied' as const }
  })
  if (decision.kind === 'missing') return err('NOT_FOUND', 'file not found')
  if (decision.kind === 'denied') return err('FORBIDDEN', 'no access to this file')
  const { file } = decision
  const mime = file.mimeType
  const inline = isAllowedMimeType(mime) ? ALLOWED_FILE_TYPES[mime].inline : isGeneratedMimeType(mime) && GENERATED_FILE_TYPES[mime].inline
  const url = await presignDownload(file.storageKey, { fileName: file.fileName, contentType: mime, inline })
  return ok({ url, expiresInSeconds: PRESIGN_TTL_SECONDS })
}

