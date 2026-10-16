import { z } from 'zod'
import { titleFromText } from '@/core/chat-intake'
import { transition, CHAT_INTAKE_MACHINE } from '@/core/state-machines'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandFailure, type CommandOutcome, type RunOptions } from '../_pipeline'
import { createDraftCommand, draftIn } from '../requests'
import { attachFileCommand } from '../requests/attachments'
import { reviewOf } from './ai'

// The LIFF side of asking through the chat (S17-07 · BR-LINE-12 · FR-LINE-301 AC4 AC6 AC7). A chat draft belongs to the
// member who wrote it: anyone else, whatever their role (ORG_ADMIN and AUDITOR included), is answered NOT_FOUND, as if it
// did not exist. Both commands lock the owner's member row first, as chat_intake.receive does, so a message arriving at
// the same moment is taken before or after, never half-way.
//  - chat_intake.draft: the owner picks a request type in LIFF; in one transaction the request draft is made by the logic
//    of request.create_draft (draftIn: the same checks and writes as the form, request.drafted with source CHAT_INTAKE),
//    with the title the owner kept — by default the first line of the text that is not blank, cut at a whole character
//    within 200 UTF-16 code units (titleFromText) — its stored photos are attached as OTHER through request.attach_file
//    (the requester changes the kind; the attachment rules are checked on submit, as for any draft), and the chat draft
//    becomes DRAFTED with the request's id. Nothing is sent: the requester checks, edits and sends in LIFF.
//  - chat_intake.dismiss: "ไม่ใช่คำขอ" — OPEN to DISMISSED; its text and photos are cleared by the hourly sweep (OQ-162).

const fail = (code: 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED', message: string, details?: Record<string, unknown>): CommandFailure => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) },
})

/** The chat draft of the acting member, locked behind their member row; null for anyone else's (NOT_FOUND) */
async function ownIntake(tx: TenantTx, ctx: Ctx, intakeId: string) {
  if (ctx.actor.type !== 'USER') return null
  const memberId = ctx.actor.memberId
  await lockRowsForUpdate(tx, 'Member', ctx.organizationId, [memberId])
  return tx.chatIntake.findFirst({
    where: { id: intakeId, memberId },
    select: { id: true, memberId: true, status: true, text: true, items: { where: { fetchStatus: 'STORED' }, select: { fileId: true }, orderBy: { seq: 'asc' } } },
  })
}

const DraftFromChatInput = z.strictObject({
  intakeId: z.uuid(),
  requestTypeCode: z.string().min(1).max(50),
  /** What the owner kept of the proposed title; absent = the first line of the text */
  title: z.string().optional(),
  /**
   * S17-08 (BR-LINE-13): the values of the Intake Agent's reading of this draft the owner took (paths as aiAssist names
   * them). The lines are taken all together or not at all, so each keeps the path it was proposed at
   */
  ai: z.strictObject({ agentActionId: z.uuid(), usePaths: z.array(z.string().min(1).max(200)).max(500) }).optional(),
})

const LINE_FIELDS = ['description', 'quantity', 'uom', 'unitPrice'] as const
/** The paths of the reading that fill something other than the lines: what draftIn takes from them */
const PLAIN_PATHS = ['title', 'deliverySiteId', 'suggestedSupplierId'] as const

/**
 * The fields of request.create_draft the owner took from the reading, and the paths they confirmed by taking them. Values
 * BR-AI-16 asks to confirm one by one (money, quantities, the supplier, low confidence) go in unconfirmed: the request
 * then waits for them (AI_REVIEW_PENDING on submit) until the requester confirms each in LIFF through request.edit. The
 * type counts as confirmed when the owner picked the one proposed.
 */
async function aiFields(tx: TenantTx, intakeId: string, requestTypeCode: string, ai: { readonly agentActionId: string; readonly usePaths: readonly string[] }) {
  const reading = await tx.agentAction.findFirst({ where: { id: ai.agentActionId, subjectType: 'CHAT_INTAKE', subjectId: intakeId, status: 'DRAFT' }, select: { review: true } })
  const review = reading ? reviewOf(reading.review) : null
  if (!review) return null
  const proposed = review.proposed
  const use = new Set(ai.usePaths.filter((p) => Object.hasOwn(proposed, p)))
  const lineCount = Object.keys(proposed).filter((p) => /^lines\.\d+\.description$/.test(p)).length
  const linePaths = Array.from({ length: lineCount }, (_, i) => LINE_FIELDS.map((f) => `lines.${i}.${f}`)).flat()
  const takesLines = [...use].some((p) => p.startsWith('lines.'))
  // All the lines with every value, or none: a line left out would move the next one to its path
  if (takesLines && !linePaths.every((p) => use.has(p))) return 'LINES' as const
  const required = new Set(review.requiredPaths)
  const fields: Record<string, unknown> = {}
  for (const path of PLAIN_PATHS) if (use.has(path)) fields[path] = proposed[path]
  if (takesLines) {
    fields.lines = Array.from({ length: lineCount }, (_, i) => ({
      description: proposed[`lines.${i}.description`],
      quantity: proposed[`lines.${i}.quantity`],
      uom: proposed[`lines.${i}.uom`],
      unitPrice: proposed[`lines.${i}.unitPrice`],
    }))
  }
  const taken = [...PLAIN_PATHS.filter((p) => use.has(p)), ...(takesLines ? linePaths : [])]
  const confirmedPaths = [...taken.filter((p) => !required.has(p)), ...(proposed.requestTypeCode === requestTypeCode ? ['requestTypeCode'] : [])]
  return { fields, confirmedPaths }
}

export const draftFromChatCommand = defineCommand({
  name: 'chat_intake.draft',
  capability: 'request.create',
  input: DraftFromChatInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ requestId: string; images: number }>> {
    const intake = await ownIntake(tx, ctx, input.intakeId)
    if (!intake) return fail('NOT_FOUND', 'no such chat draft')
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [intake.memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (!transition(CHAT_INTAKE_MACHINE, intake.status, 'chat_intake.draft').ok) return fail('INVALID_STATE_TRANSITION', `the chat draft is ${intake.status}`, { from: intake.status })
    const ai = input.ai ? await aiFields(tx, intake.id, input.requestTypeCode, input.ai) : undefined
    if (ai === null) return fail('VALIDATION_FAILED', 'the AI reading is not one of this chat draft', { field: 'ai.agentActionId' })
    if (ai === 'LINES') return fail('VALIDATION_FAILED', 'the lines the AI read are taken all together', { field: 'ai.usePaths', reason: 'AI_LINES' })
    const title = typeof ai?.fields.title === 'string' ? ai.fields.title : (input.title ?? titleFromText(intake.text ?? ''))
    const fields = createDraftCommand.input.safeParse({
      requestTypeCode: input.requestTypeCode,
      ...(ai ? { ...ai.fields, aiAssist: { agentActionId: input.ai!.agentActionId, confirmedPaths: ai.confirmedPaths } } : {}),
      title,
    })
    if (!fields.success) {
      const field = String(fields.error.issues[0]?.path[0] ?? 'title')
      return fail('VALIDATION_FAILED', 'the draft needs a title and a request type', { field, ...(field === 'title' ? { reason: 'INTAKE_TITLE' } : field === 'requestTypeCode' ? { reason: 'INTAKE_TYPE' } : {}) })
    }
    const drafted = await draftIn(tx, ctx, fields.data, { source: 'CHAT_INTAKE' })
    if (!drafted.ok) {
      // The type the owner picked cannot make a request (unknown, off, or no published form): reason INTAKE_TYPE
      const details = drafted.error.details
      return details?.field === 'requestTypeCode' ? { ok: false, error: { ...drafted.error, details: { ...details, reason: 'INTAKE_TYPE', ...(details.reason ? { cause: details.reason } : {}) } } } : drafted
    }
    const requestId = drafted.result.requestId
    const events: EventDraft[] = [...drafted.events]
    let images = 0
    for (const { fileId } of intake.items) {
      if (!fileId) continue
      const attached = await attachFileCommand.execute(tx, { requestId, fileId, kind: 'OTHER' }, ctx)
      if (!attached.ok) return attached
      events.push(...attached.events)
      images++
    }
    const type = await tx.requestType.findFirstOrThrow({ where: { code: input.requestTypeCode }, select: { id: true } })
    await tx.chatIntake.update({
      where: { id: intake.id },
      data: { status: 'DRAFTED', requestId, requestTypeId: type.id, draftedAt: ctx.now, closedAt: ctx.now, version: { increment: 1 } },
    })
    events.push({ type: 'chat_intake.drafted', aggregateType: 'ChatIntake', aggregateId: intake.id, data: { requestId, requestTypeCode: input.requestTypeCode, images, aiAssisted: ai !== undefined } })
    return { ok: true, result: { requestId, images }, events }
  },
})

export const dismissChatIntakeCommand = defineCommand({
  name: 'chat_intake.dismiss',
  capability: 'request.create',
  input: z.strictObject({ intakeId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ intakeId: string }>> {
    const intake = await ownIntake(tx, ctx, input.intakeId)
    if (!intake) return fail('NOT_FOUND', 'no such chat draft')
    const allowed = await authorize(tx, ctx, 'request.create', { ownerMemberIds: [intake.memberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (!transition(CHAT_INTAKE_MACHINE, intake.status, 'chat_intake.dismiss').ok) return fail('INVALID_STATE_TRANSITION', `the chat draft is ${intake.status}`, { from: intake.status })
    await tx.chatIntake.update({ where: { id: intake.id }, data: { status: 'DISMISSED', closedAt: ctx.now, version: { increment: 1 } } })
    return { ok: true, result: { intakeId: intake.id }, events: [{ type: 'chat_intake.dismissed', aggregateType: 'ChatIntake', aggregateId: intake.id, data: {} }] }
  },
})

export function draftFromChat(ctx: Ctx, input: z.input<typeof DraftFromChatInput>, options: RunOptions) {
  return runCommand(ctx, draftFromChatCommand, input, options)
}

export function dismissChatIntake(ctx: Ctx, input: { readonly intakeId: string }, options: RunOptions) {
  return runCommand(ctx, dismissChatIntakeCommand, input, options)
}
