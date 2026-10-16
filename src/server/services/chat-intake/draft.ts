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
})

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
    const title = input.title ?? titleFromText(intake.text ?? '')
    const fields = createDraftCommand.input.safeParse({ requestTypeCode: input.requestTypeCode, title })
    if (!fields.success) {
      const field = String(fields.error.issues[0]?.path[0] ?? 'title')
      return fail('VALIDATION_FAILED', 'the draft needs a title and a request type', { field, ...(field === 'title' ? { reason: 'INTAKE_TITLE' } : {}) })
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
    events.push({ type: 'chat_intake.drafted', aggregateType: 'ChatIntake', aggregateId: intake.id, data: { requestId, requestTypeCode: input.requestTypeCode, images, aiAssisted: false } })
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
