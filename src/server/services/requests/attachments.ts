import { z } from 'zod'
import type { AttachmentRule, Requirement } from '@/core/forms'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { formDefinition } from '@/server/forms/schema'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// Attachments of a request (spec FR-INT-005, BR-FORM-03, FR-PLT-004 AC2): the requester uploads a file through the
// presigned upload flow (services/files), then links it to their draft or returned request as one kind of attachment
// (FileLink subjectType "Request"). The attachment rules count these links by kind at submit, and the file then
// downloads only for those who may view the request (files/request-policy.ts). Quotation files are linked by the
// quotations themselves (BR-FORM-06, quotations.ts), never one by one, so a quotation always carries its data.
// Linking or taking off a file changes the draft, so the event is the catalog's request.drafted (§10.2) naming the file
// and what happened to it; the timeline counts it with the requester's other changes.

/** FileLinkKind of the schema (§6.2) */
export const FILE_LINK_KINDS = ['QUOTATION', 'DELIVERY_NOTE', 'PHOTO', 'JUSTIFICATION', 'INVOICE', 'PO_PDF', 'DPA', 'ETAX', 'REGISTRY_PROOF', 'OTHER'] as const
export type FileLinkKind = (typeof FILE_LINK_KINDS)[number]

/** What any request may carry besides the kinds its form's rules ask for */
export const REQUEST_ATTACHMENT_KINDS: readonly FileLinkKind[] = ['DPA', 'JUSTIFICATION', 'PHOTO', 'OTHER']

/** A request carries at most this many attached files besides its quotations */
export const MAX_REQUEST_ATTACHMENTS = 50

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** The kinds of attachment a requirement counts, wherever they sit in it */
function kindsIn(requirement: Requirement): string[] {
  if ('attachments' in requirement) return [requirement.attachments]
  if ('all' in requirement) return requirement.all.flatMap(kindsIn)
  if ('any' in requirement) return requirement.any.flatMap(kindsIn)
  return []
}

/** The kinds the requester may attach one by one: the usual ones and those the form's rules ask for, never QUOTATION */
export function attachableKinds(rules: readonly AttachmentRule[]): FileLinkKind[] {
  const asked = new Set(rules.flatMap((r) => kindsIn(r.require)))
  return FILE_LINK_KINDS.filter((k) => k !== 'QUOTATION' && (REQUEST_ATTACHMENT_KINDS.includes(k) || asked.has(k)))
}

/** The request locked, with its form, for a change of its attachments */
async function lockedRequest(tx: TenantTx, ctx: Ctx, requestId: string) {
  const [locked] = await lockRowsForUpdate(tx, 'Request', ctx.organizationId, [requestId])
  if (!locked) return null
  return tx.request.findUniqueOrThrow({
    where: { id: requestId },
    select: { id: true, status: true, requesterMemberId: true, formVersion: { select: { schema: true } }, requestType: { select: { code: true } }, _count: { select: { lines: true } } },
  })
}

type LockedRequest = NonNullable<Awaited<ReturnType<typeof lockedRequest>>>

/** request.drafted for a file linked to the request or taken off it */
function fileEvent(request: LockedRequest, file: { action: 'ATTACHED' | 'DETACHED'; fileId: string; kinds: readonly string[] }) {
  return { type: 'request.drafted', aggregateType: 'Request', aggregateId: request.id, data: { requestTypeCode: request.requestType.code, lines: request._count.lines, file } }
}

const editable = (status: string) => status === 'DRAFT' || status === 'RETURNED'

const AttachInput = z.strictObject({ requestId: z.uuid(), fileId: z.uuid(), kind: z.enum(FILE_LINK_KINDS) })

export const attachFileCommand = defineCommand({
  name: 'request.attach_file',
  capability: 'request.create',
  input: AttachInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; fileId: string; kind: FileLinkKind }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (!editable(request.status)) return fail('INVALID_STATE_TRANSITION', 'files are attached to a draft or a returned request only', { from: request.status })
    if (input.kind === 'QUOTATION') return fail('VALIDATION_FAILED', 'a quotation file comes with its quotation', { field: 'kind', reason: 'USE_QUOTATIONS' })
    if (!attachableKinds(formDefinition(request.formVersion.schema).rules).includes(input.kind)) {
      return fail('VALIDATION_FAILED', 'this kind of file is not attached to a request', { field: 'kind', reason: 'KIND' })
    }
    // Only a file the requester uploaded and the service verified (sha256, type) can be attached
    const file = await tx.fileObject.findFirst({ where: { id: input.fileId, uploadedById: request.requesterMemberId, status: 'AVAILABLE' }, select: { id: true } })
    if (!file) return fail('VALIDATION_FAILED', 'the file must be one you uploaded', { field: 'fileId', reason: 'FILE' })
    const links = await tx.fileLink.findMany({ where: { subjectType: 'Request', subjectId: request.id }, select: { fileId: true, kind: true } })
    if (links.some((l) => l.fileId === file.id)) return fail('VALIDATION_FAILED', 'the file is attached already', { field: 'fileId', reason: 'ALREADY_ATTACHED' })
    if (links.filter((l) => l.kind !== 'QUOTATION').length >= MAX_REQUEST_ATTACHMENTS) {
      return fail('VALIDATION_FAILED', 'the request has the most files it can carry', { field: 'fileId', reason: 'TOO_MANY', max: MAX_REQUEST_ATTACHMENTS })
    }
    await tx.fileLink.create({ data: { organizationId: ctx.organizationId, fileId: file.id, subjectType: 'Request', subjectId: request.id, kind: input.kind } })
    return {
      ok: true,
      result: { requestId: request.id, fileId: file.id, kind: input.kind },
      events: [fileEvent(request, { action: 'ATTACHED', fileId: file.id, kinds: [input.kind] })],
    }
  },
})

export function attachFile(ctx: Ctx, input: z.input<typeof AttachInput>, options: RunOptions) {
  return runCommand(ctx, attachFileCommand, input, options)
}

const DetachInput = z.strictObject({ requestId: z.uuid(), fileId: z.uuid() })

export const detachFileCommand = defineCommand({
  name: 'request.detach_file',
  capability: 'request.create',
  input: DetachInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; fileId: string }>> {
    const request = await lockedRequest(tx, ctx, input.requestId)
    if (!request) return fail('NOT_FOUND', 'request not found')
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (!editable(request.status)) return fail('INVALID_STATE_TRANSITION', 'files are taken off a draft or a returned request only', { from: request.status })
    // A quotation's file goes with its quotation (removing the quotation in the form removes the link)
    const links = await tx.fileLink.findMany({ where: { subjectType: 'Request', subjectId: request.id, fileId: input.fileId, kind: { not: 'QUOTATION' } }, select: { id: true, kind: true } })
    if (links.length === 0) return fail('NOT_FOUND', 'the file is not attached to this request', { field: 'fileId' })
    await tx.fileLink.deleteMany({ where: { id: { in: links.map((l) => l.id) } } })
    return {
      ok: true,
      result: { requestId: request.id, fileId: input.fileId },
      events: [fileEvent(request, { action: 'DETACHED', fileId: input.fileId, kinds: [...new Set(links.map((l) => l.kind))] })],
    }
  },
})

export function detachFile(ctx: Ctx, input: z.input<typeof DetachInput>, options: RunOptions) {
  return runCommand(ctx, detachFileCommand, input, options)
}
