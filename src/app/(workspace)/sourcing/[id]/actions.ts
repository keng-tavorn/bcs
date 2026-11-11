'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { summarizeRfx, type SummaryPurpose } from '@/server/services/ai'
import { amendRfx, answerQuestion, cancelRfx, closeRfxEarly, concludeRfx, exportComparison, extendRfx } from '@/server/services/sourcing'
import { bidFileUrl } from '@/server/services/sourcing/rfx-view'
import type { AnswerInput } from '@/ui/sourcing/rfx-detail/answer-form'
import type { RfxActionOutcome, RfxExportOutcome } from '@/ui/sourcing/rfx-detail/model'
import type { AmendInput } from '@/ui/sourcing/rfx-detail/revision-forms'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /sourcing/[id] (S10-12): the session, then the service, which checks SOURCING,
// sourcing.manage (sourcing.view for the export), the state machine, the version and the time every time (BR-AUTH-05).
// A refusal comes back as its code and the reason the screen names, nothing else (§14.2). The key is the client's uuid.

const uuid = z.uuid()
const page = (id: string) => `/sourcing/${id}`
type Ctx = NonNullable<ReturnType<typeof ctxFromSession>>
type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: AppError }

function refused(error: AppError): { readonly ok: false; readonly code: string; readonly reason?: string } {
  const reason = error.details?.reason
  return { ok: false, code: error.code, ...(typeof reason === 'string' ? { reason } : {}) }
}

async function session(): Promise<Ctx | null> {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

async function run(rfxEventId: string, key: string, call: (ctx: Ctx) => Promise<Outcome>): Promise<RfxActionOutcome> {
  const ctx = await session()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!uuid.safeParse(key).success || !uuid.safeParse(rfxEventId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await call(ctx)
  if (!r.ok) return refused(r.error)
  revalidatePath(page(rfxEventId))
  return { ok: true }
}

const version = (v: number) => Number.isInteger(v) && v >= 0

export async function answerQuestionAction(rfxEventId: string, input: AnswerInput, key: string): Promise<RfxActionOutcome> {
  if (!uuid.safeParse(input.questionId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) =>
    answerQuestion(
      ctx,
      {
        rfxEventId,
        questionId: input.questionId,
        answer: input.answer,
        visibility: input.visibility === 'ASKER' ? 'ASKER' : 'ALL',
        ...(input.askerOnlyReason ? { askerOnlyReason: input.askerOnlyReason } : {}),
        ...(input.publishedQuestion ? { publishedQuestion: input.publishedQuestion } : {}),
      },
      { idempotencyKey: key },
    ),
  )
}

export async function amendRfxAction(rfxEventId: string, input: AmendInput, key: string): Promise<RfxActionOutcome> {
  if (!version(input.expectedVersion)) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) =>
    amendRfx(
      ctx,
      {
        rfxEventId,
        expectedVersion: input.expectedVersion,
        summary: input.summary,
        ...(input.summaryEn !== undefined ? { summaryEn: input.summaryEn } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.titleEn !== undefined ? { titleEn: input.titleEn } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.descriptionEn !== undefined ? { descriptionEn: input.descriptionEn } : {}),
        ...(input.closesAt !== undefined ? { closesAt: input.closesAt } : {}),
      },
      { idempotencyKey: key },
    ),
  )
}

export async function extendRfxAction(rfxEventId: string, expectedVersion: number, closesAt: string, key: string): Promise<RfxActionOutcome> {
  if (!version(expectedVersion)) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => extendRfx(ctx, { rfxEventId, expectedVersion, closesAt }, { idempotencyKey: key }))
}

export async function cancelRfxAction(rfxEventId: string, expectedVersion: number, reason: string, key: string): Promise<RfxActionOutcome> {
  if (!version(expectedVersion)) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => cancelRfx(ctx, { rfxEventId, expectedVersion, reason }, { idempotencyKey: key }))
}

export async function closeRfxEarlyAction(rfxEventId: string, expectedVersion: number, reason: string, key: string): Promise<RfxActionOutcome> {
  if (!version(expectedVersion)) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => closeRfxEarly(ctx, { rfxEventId, expectedVersion, reason }, { idempotencyKey: key }))
}

export async function concludeRfxAction(rfxEventId: string, expectedVersion: number, conclusionNote: string, key: string): Promise<RfxActionOutcome> {
  if (!version(expectedVersion)) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => concludeRfx(ctx, { rfxEventId, expectedVersion, conclusionNote }, { idempotencyKey: key }))
}

/** The comparison as Excel (rfx.exportComparison · a reader of the RFx's prices, once the envelope is open) */
export async function exportComparisonAction(rfxEventId: string, key: string): Promise<RfxExportOutcome> {
  const ctx = await session()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!uuid.safeParse(key).success || !uuid.safeParse(rfxEventId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await exportComparison(ctx, { rfxEventId }, { idempotencyKey: key })
  return r.ok ? { ok: true, fileId: r.data.fileId } : refused(r.error)
}

/** A five-minute link to a clean file of a sent bid; null when it may not be opened */
export async function openBidFileAction(rfxEventId: string, fileId: string): Promise<string | null> {
  const ctx = await session()
  if (!ctx) return null
  const r = await bidFileUrl(ctx, rfxEventId, fileId)
  return r.ok ? r.data.url : null
}

export type SummarizeOutcome = { readonly kind: 'READY'; readonly agentActionId: string; readonly sentences: readonly string[] } | { readonly kind: 'FAILED' }

/** "สรุปข้อเสนอ" or "ประเด็นเจรจา" after the close (S10-16 · BR-AI-32): the service checks the reader and the AI's words */
export async function summarizeRfxAction(rfxEventId: string, purpose: SummaryPurpose, key: string): Promise<SummarizeOutcome> {
  const ctx = await session()
  if (!ctx || !uuid.safeParse(rfxEventId).success || !uuid.safeParse(key).success) return { kind: 'FAILED' }
  const r = await summarizeRfx(ctx, { rfxEventId, purpose }, { idempotencyKey: key })
  return r.ok && r.data.status === 'READY' ? { kind: 'READY', agentActionId: r.data.agentActionId, sentences: r.data.sentences } : { kind: 'FAILED' }
}
