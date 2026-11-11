'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { cancelAward, createAward, releaseAwardPo, submitAward, updateAward } from '@/server/services/sourcing'
import type { AwardOutcome, AwardSaveInput } from '@/ui/sourcing/award-model'
import { getSession } from '../../../../_lib/session'

// Browser-facing adapters of /sourcing/[id]/award (S10-10 · FR-SRC-204 AC2): the session, then the service, which checks
// SOURCING, sourcing.award, the state, the version and the reasons every time (BR-AUTH-05). A refusal comes back as its
// code and screen-safe details only (§14.2).

const uuid = z.uuid()
const page = (id: string) => `/sourcing/${id}/award`

function refused(error: AppError): AwardOutcome {
  const details = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof details.reason === 'string' ? { reason: details.reason } : {}),
    ...(Array.isArray(details.reasonCodes) ? { reasonCodes: details.reasonCodes.filter((c): c is string => typeof c === 'string') } : {}),
  }
}

async function run(rfxEventId: string, key: string, call: (ctx: NonNullable<ReturnType<typeof ctxFromSession>>) => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AppError }>): Promise<AwardOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!uuid.safeParse(key).success || !uuid.safeParse(rfxEventId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await call(ctx)
  if (!r.ok) return refused(r.error)
  revalidatePath(page(rfxEventId))
  return { ok: true }
}

const text = (v: string): string | null => (v.trim() ? v.trim() : null)

export async function saveAwardAction(rfxEventId: string, input: AwardSaveInput, key: string): Promise<AwardOutcome> {
  const reason = text(input.reason)
  const contractRef = text(input.contractRef)
  return run(rfxEventId, key, (ctx) =>
    input.awardDecisionId && input.version !== undefined
      ? updateAward(ctx, { awardDecisionId: input.awardDecisionId, version: input.version, lines: [...input.lines], reason, contractRef }, { idempotencyKey: key })
      : createAward(ctx, { rfxEventId, lines: [...input.lines], ...(reason ? { reason } : {}), ...(contractRef ? { contractRef } : {}) }, { idempotencyKey: key }),
  )
}

/** One send per version of the award (§4.3): a double click gets the first answer; a refusal is not kept, so it can be sent again */
export async function submitAwardAction(rfxEventId: string, awardDecisionId: string, version: number, key: string): Promise<AwardOutcome> {
  if (!uuid.safeParse(awardDecisionId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => submitAward(ctx, { awardDecisionId, version }, { idempotencyKey: `award.submit:${awardDecisionId}:${version}` }))
}

export async function cancelAwardAction(rfxEventId: string, awardDecisionId: string, version: number, reason: string, key: string): Promise<AwardOutcome> {
  if (!uuid.safeParse(awardDecisionId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => cancelAward(ctx, { awardDecisionId, version, reason }, { idempotencyKey: key }))
}

/** S10-11 (OQ-212): the POs of an award whose winners confirmed their prices before VAT — once per version */
export async function releaseAwardPoAction(rfxEventId: string, awardDecisionId: string, version: number, key: string): Promise<AwardOutcome> {
  if (!uuid.safeParse(awardDecisionId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  return run(rfxEventId, key, (ctx) => releaseAwardPo(ctx, { awardDecisionId, version }, { idempotencyKey: `award.releasePo:${awardDecisionId}:${version}` }))
}
