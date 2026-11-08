'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { recuseEvaluator, saveScores, submitScores } from '@/server/services/sourcing'
import type { ScoreEntryInput, ScoreOutcome } from '@/ui/sourcing/score-model'
import { getSession } from '../../../../_lib/session'

// Browser-facing adapters of /sourcing/[id]/score (S10-08 · FR-SRC-203 AC2): the session, then the service, which checks
// SOURCING, sourcing.score for an evaluator of this scorecard, BR-SOD-14 and the state every time (BR-AUTH-05). A
// refusal comes back as its code and screen-safe details only (§14.2).

const submissionKey = z.uuid()
const page = (id: string) => `/sourcing/${id}/score`

function refused(error: AppError): ScoreOutcome {
  const details = error.details ?? {}
  return { ok: false, code: error.code, ...(typeof details.reason === 'string' ? { reason: details.reason } : {}), ...(typeof details.missing === 'number' ? { missing: details.missing } : {}) }
}

async function run(rfxEventId: string, key: string, call: (ctx: NonNullable<ReturnType<typeof ctxFromSession>>) => Promise<{ readonly ok: true; readonly data: object } | { readonly ok: false; readonly error: AppError }>): Promise<ScoreOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  if (!submissionKey.safeParse(key).success || !submissionKey.safeParse(rfxEventId).success) return { ok: false, code: 'VALIDATION_FAILED' }
  const r = await call(ctx)
  if (!r.ok) return refused(r.error)
  revalidatePath(page(rfxEventId))
  return { ok: true, revealed: 'revealed' in r.data && r.data.revealed === true }
}

export async function saveScoresAction(rfxEventId: string, entries: ScoreEntryInput[], key: string) {
  return run(rfxEventId, key, (ctx) => saveScores(ctx, { rfxEventId, entries }, { idempotencyKey: key }))
}

/**
 * One send per evaluator per scorecard (docs/sub-specs/S10.md: score:<scorecardId>:<memberId> · §4.3): a double click
 * gets the first answer; a refusal (scores missing) is not kept, so the evaluator sends again with the same key
 */
export async function submitScoresAction(rfxEventId: string, scorecardId: string, entries: ScoreEntryInput[], key: string) {
  if (!submissionKey.safeParse(scorecardId).success) return { ok: false, code: 'VALIDATION_FAILED' } satisfies ScoreOutcome
  return run(rfxEventId, key, (ctx) => submitScores(ctx, { rfxEventId, entries }, { idempotencyKey: `score:${scorecardId}:${ctx.actor.type === 'USER' ? ctx.actor.memberId : 'none'}` }))
}

export async function recuseAction(rfxEventId: string, reason: string, key: string) {
  return run(rfxEventId, key, (ctx) => recuseEvaluator(ctx, { rfxEventId, reason }, { idempotencyKey: key }))
}
