import { z } from 'zod'
import type { AppError } from '@/core/result'
import { RFX_LONG_TEXT_MAX, RFX_QUESTION_MAX } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { enqueueSupplierNotice } from '@/server/notifications/supplier-notices'
import { SOURCING_SUPPLIER_TEMPLATES } from '@/server/notifications/supplier-templates-sourcing'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { absorb, effects, orgCodeOf, portalLoginUrl } from './invites'
import { gate, lockedRfx, releaseSources, step } from './rfx'

// Questions and answers of an RFx, and the end of an RFI (S10-05 · BR-RFX-02 · BR-RFX-04 · FR-SRC-201 AC4): a contact of
// an invited supplier or application asks until questionCutoffAt (QUESTION_CUTOFF_PASSED); PROCUREMENT answers until the
// close, to every invite that has not declined or been removed without naming who asked (ALL), or to the asker only
// (ASKER, with a reason, for a question that tells a trade secret of the asker). Before publishing PROCUREMENT may word
// the question again: the asker's own words stay as a comment of the question. No price in a question or an answer.
// An RFI ends CONCLUDED with procurement's summary: no award, no PO.

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false
const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

/** The invite statuses that hear an answer to ALL (BR-RFX-04) */
const HEARS_ANSWERS = ['INVITED', 'VIEWED', 'BID_SUBMITTED', 'WITHDRAWN'] as const

/** The invite of the contact's supplier or application on the RFx, or null */
async function inviteOfContact(tx: TenantTx, ctx: Ctx, rfxEventId: string) {
  if (ctx.actor.type !== 'SUPPLIER') return null
  const owner = ctx.actor.supplierId ? { supplierId: ctx.actor.supplierId } : ctx.actor.applicationId ? { applicationId: ctx.actor.applicationId } : null
  if (!owner) return null
  return tx.rfxInvite.findFirst({ where: { rfxEventId, ...owner }, select: { id: true, status: true } })
}

// ---------- portal.rfx.ask (the contact · BR-RFX-04) ----------

const AskInput = z.strictObject({ rfxEventId: z.uuid(), question: z.string().trim().min(1).max(RFX_QUESTION_MAX) })

export const askQuestionCommand = defineCommand({
  name: 'portal.rfx.ask',
  capability: 'portal.rfx.ask',
  input: AskInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ questionId: string }>> {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return { ok: false, error: on.error }
    // the rule of portal.rfx.ask in src/server/portal/authz.ts, which services do not import: a portal request of an
    // invited contact (not removed, not expired) while the RFx is open; an RFx the contact is not invited to does not exist
    // for them (INV-RFX-01)
    if (ctx.actor.type !== 'SUPPLIER' || ctx.channel !== 'PORTAL') return fail('FORBIDDEN', 'not a portal request', { action: 'portal.rfx.ask' })
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    const invite = rfx ? await inviteOfContact(tx, ctx, rfx.id) : null
    if (!rfx || !invite || invite.status === 'REMOVED') return fail('NOT_FOUND', 'RFx not found')
    if (rfx.status !== 'OPEN' || invite.status === 'EXPIRED') return fail('FORBIDDEN', 'the contact may not portal.rfx.ask', { action: 'portal.rfx.ask' })
    if (!rfx.questionCutoffAt || ctx.now.getTime() >= rfx.questionCutoffAt.getTime()) return fail('QUESTION_CUTOFF_PASSED', 'questions closed', { cutoff: rfx.questionCutoffAt?.toISOString() ?? null })
    const contactId = ctx.actor.type === 'SUPPLIER' ? ctx.actor.supplierContactId : ''
    const q = await tx.rfxQuestion.create({ data: { organizationId: ctx.organizationId, rfxEventId: rfx.id, inviteId: invite.id, question: input.question, askedByContactId: contactId, askedAt: ctx.now }, select: { id: true } })
    return {
      ok: true,
      result: { questionId: q.id },
      // the question's words never go into an event or a notification (a supplier's text · BR-AI-32)
      events: [{ type: 'rfx.question_asked', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { questionId: q.id, inviteId: invite.id } }],
      notifications: [
        { recipientMemberId: rfx.createdById, templateKey: 'rfx.question_asked', data: { rfxEventId: rfx.id, number: rfx.number, title: rfx.title }, urgency: 'IMMEDIATE', dedupeKey: `rfx.question_asked:${q.id}`, subjectType: 'RfxEvent', subjectId: rfx.id },
      ],
    }
  },
})

// ---------- rfx.answerQuestion (PROCUREMENT · BR-RFX-04) ----------

const AnswerInput = z.strictObject({
  rfxEventId: z.uuid(),
  questionId: z.uuid(),
  answer: z.string().trim().min(1).max(RFX_LONG_TEXT_MAX),
  visibility: z.enum(['ALL', 'ASKER']).default('ALL'),
  /** ASKER only: why the answer goes to the asker alone (a trade secret of the asker) */
  askerOnlyReason: z.string().trim().min(3).max(500).optional(),
  /** The question as published to everyone; the asker's own words stay as a comment of the question */
  publishedQuestion: z.string().trim().min(1).max(RFX_QUESTION_MAX).optional(),
})

export const answerQuestionCommand = defineCommand({
  name: 'rfx.answerQuestion',
  capability: 'sourcing.manage',
  input: AnswerInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ questionId: string; notified: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    if (rfx.status !== 'OPEN' || !rfx.closesAt || ctx.now.getTime() >= rfx.closesAt.getTime()) return fail('INVALID_STATE_TRANSITION', 'questions are answered until the close', { from: rfx.status, command: 'rfx.answerQuestion', reason: 'PAST_CLOSE' })
    await lockRowsForUpdate(tx, 'RfxQuestion', ctx.organizationId, [input.questionId])
    const q = await tx.rfxQuestion.findFirst({ where: { id: input.questionId, rfxEventId: rfx.id }, select: { id: true, status: true, question: true, inviteId: true } })
    if (!q) return fail('NOT_FOUND', 'question not found')
    if (q.status !== 'OPEN') return fail('INVALID_STATE_TRANSITION', `rfx.answerQuestion is not allowed from ${q.status}`, { from: q.status, command: 'rfx.answerQuestion' })
    if (input.visibility === 'ASKER' && !input.askerOnlyReason) return fail('VALIDATION_FAILED', 'an answer to the asker alone needs a reason', { field: 'askerOnlyReason', reason: 'ASKER_ONLY_REASON' })
    let originalCommentId: string | null = null
    if (input.publishedQuestion && input.publishedQuestion !== q.question) {
      originalCommentId = (await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'RfxQuestion', subjectId: q.id, authorMemberId: memberOf(ctx), body: q.question }, select: { id: true } })).id
    }
    const reasonCommentId = input.askerOnlyReason ? (await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'RfxQuestion', subjectId: q.id, authorMemberId: memberOf(ctx), body: input.askerOnlyReason }, select: { id: true } })).id : null
    const published = input.publishedQuestion ?? q.question
    await tx.rfxQuestion.update({ where: { id: q.id }, data: { question: published, answer: input.answer, answeredById: memberOf(ctx), answeredAt: ctx.now, status: 'ANSWERED', visibility: input.visibility, version: { increment: 1 } } })
    const invites = await tx.rfxInvite.findMany({
      where: input.visibility === 'ALL' ? { rfxEventId: rfx.id, status: { in: [...HEARS_ANSWERS] } } : { id: q.inviteId },
      orderBy: [{ invitedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, contactId: true, supplierId: true, applicationId: true },
    })
    const orgCode = await orgCodeOf(tx, ctx.organizationId)
    const out = effects()
    for (const i of invites) {
      absorb(
        out,
        await enqueueSupplierNotice(tx, ctx, {
          templateKey: SOURCING_SUPPLIER_TEMPLATES.questionAnswered,
          contactId: i.contactId,
          supplierId: i.supplierId,
          applicationId: i.applicationId,
          subjectType: 'RfxEvent',
          subjectId: rfx.id,
          dedupeKey: `rfx.question_answered:${q.id}:${i.id}`,
          data: { number: rfx.number, title: rfx.title, titleEn: rfx.titleEn, question: published, answer: input.answer, loginUrl: portalLoginUrl(orgCode) },
        }),
      )
    }
    const events: EventDraft[] = [
      { type: 'rfx.question_answered', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { questionId: q.id, visibility: input.visibility, notified: invites.length, originalCommentId, reasonCommentId } },
      ...out.events,
    ]
    return { ok: true, result: { questionId: q.id, notified: invites.length }, events, notifications: out.notifications, outbox: out.outbox }
  },
})

// ---------- rfx.conclude (an RFI ends with its summary · BR-RFX-02) ----------

const ConcludeInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), conclusionNote: z.string().trim().min(3).max(RFX_LONG_TEXT_MAX) })

export const concludeRfxCommand = defineCommand({
  name: 'rfx.conclude',
  capability: 'sourcing.manage',
  input: ConcludeInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ rfxEventId: string; requestLineIds: string[] }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const next = step(rfx, 'rfx.conclude', input.expectedVersion)
    if (isFail(next)) return next
    if (rfx.kind !== 'RFI') return fail('INVALID_STATE_TRANSITION', 'an RFQ or RFP ends with an award, not a conclusion', { from: rfx.status, command: 'rfx.conclude', reason: 'NOT_RFI' })
    // the lines of an RFI made from the pool go back to it: an RFI buys nothing
    const requestLineIds = await releaseSources(tx, { rfxEventId: rfx.id })
    await tx.rfxEvent.update({ where: { id: rfx.id }, data: { status: 'CONCLUDED', conclusionNote: input.conclusionNote, version: { increment: 1 } } })
    return { ok: true, result: { rfxEventId: rfx.id, requestLineIds }, events: [{ type: 'rfx.concluded', aggregateType: 'RfxEvent', aggregateId: rfx.id, data: { requestLineIds } }] }
  },
})

export const askQuestion = (ctx: Ctx, input: z.input<typeof AskInput>, opts: RunOptions) => runCommand(ctx, askQuestionCommand, input, opts)
export const answerQuestion = (ctx: Ctx, input: z.input<typeof AnswerInput>, opts: RunOptions) => runCommand(ctx, answerQuestionCommand, input, opts)
export const concludeRfx = (ctx: Ctx, input: z.input<typeof ConcludeInput>, opts: RunOptions) => runCommand(ctx, concludeRfxCommand, input, opts)
