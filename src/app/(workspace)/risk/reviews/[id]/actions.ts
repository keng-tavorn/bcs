'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { RISK_TEXT_MAX } from '@/lib/constants'
import { decideRiskReview, requestRiskEvidenceDownload } from '@/server/services/risk'
import type { ReviewOutcome } from '@/ui/risk-review/model'
import { currentCtx, openRiskFile } from '../../_outcome'

// Browser-facing adapters of /risk/reviews/[id] (S11-06 · FR-RSK-202 AC3 · BR-RSK-08): a server action is a public
// endpoint, so every value is checked for its shape here — the ids and the submission key are UUIDs, the decision one
// of two, the reason text of a bounded length — and the service then checks the RISK module, the slot's holder, the
// state and separation of duties every time (BR-AUTH-05 · BR-SOD-16). A refusal returns its code and the details the
// screen may show (who decided the task first and when, the field missing), never the service's message (§14.2).

const Id = z.uuid()
const DecideForm = z.strictObject({
  decision: z.enum(['PASS', 'RETURN']),
  reason: z.string().trim().max(RISK_TEXT_MAX).optional(),
  shareWithSupplier: z.boolean().optional(),
})

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function refusedReview(error: AppError): Extract<ReviewOutcome, { ok: false }> {
  const d = error.details ?? {}
  const field = text(d.field)
  const name = text(d.name)
  const nameEn = text(d.nameEn)
  const time = text(d.time)
  return { ok: false, code: error.code, ...(field ? { field } : {}), ...(name ? { name } : {}), ...(nameEn ? { nameEn } : {}), ...(time ? { time } : {}) }
}

/** Pass or return the member's slot: only a return carries a reason, and only a return may share it with the supplier */
export async function decideReviewAction(taskId: string, input: unknown, key: string): Promise<ReviewOutcome> {
  const form = DecideForm.safeParse(input)
  if (!Id.safeParse(taskId).success || !form.success) return { ok: false, code: 'VALIDATION_FAILED' }
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!Id.safeParse(key).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const { decision, reason, shareWithSupplier } = form.data
  const r = await decideRiskReview(
    ctx,
    decision === 'RETURN' ? { taskId, decision, ...(reason ? { reason } : {}), shareWithSupplier: shareWithSupplier ?? false } : { taskId, decision },
    { idempotencyKey: key },
  )
  if (!r.ok) return refusedReview(r.error)
  revalidatePath(`/risk/reviews/${taskId}`)
  revalidatePath('/risk/reviews')
  return { ok: true, decision: r.data.decision, assessment: r.data.assessment }
}

/** An evidence file behind an answer of the slot's own part (the service checks the reviewer and the scan, CLEAN only) */
export async function openReviewEvidenceFileAction(assessmentId: string, fileId: string, key: string) {
  if (!Id.safeParse(assessmentId).success || !Id.safeParse(fileId).success) return { ok: false as const, code: 'VALIDATION_FAILED' }
  return openRiskFile(key, (ctx) => requestRiskEvidenceDownload(ctx, { assessmentId, fileId }, { idempotencyKey: key }))
}
