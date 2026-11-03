'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { FOLLOW_UP_PATH, FOLLOW_UP_VIAS } from '@/lib/follow-up'
import { ctxFromSession } from '@/server/auth/session'
import { sendFollowUp } from '@/server/services/assistants/follow-up'
import type { FollowUpOutcome } from '@/ui/assistants/follow-up-draft'
import { toInsightFailure } from '@/ui/insight/outcome'
import { getSession } from '../../_lib/session'

// Browser-facing adapter of the follow-up assistant's send (NEW-124 · ADR-082). It checks the session; the service checks
// that the member follows the document, the task's state and holder, the day's limit and the quiet time after the
// system's notices again (BR-AUTH-05). The idempotencyKey comes from the confirmation (spec §4.3), so the same press sent
// twice nudges once.

const NO_SESSION: FollowUpOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_INPUT: FollowUpOutcome = { ok: false, code: 'VALIDATION_FAILED' }
const Input = z.object({ taskId: z.uuid(), via: z.enum(FOLLOW_UP_VIAS), text: z.string() })

export async function sendFollowUpAction(input: unknown, idempotencyKey: string): Promise<FollowUpOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  const parsed = Input.safeParse(input)
  if (!parsed.success || !z.uuid().safeParse(idempotencyKey).success) return BAD_INPUT
  const result = await sendFollowUp(ctx, parsed.data, { idempotencyKey })
  if (!result.ok) {
    const { code, reason, nextAt, requestId } = toInsightFailure(result.error)
    return { ok: false, code, ...(reason ? { reason } : {}), ...(nextAt ? { nextAt } : {}), ...(requestId ? { requestId } : {}) }
  }
  revalidatePath(FOLLOW_UP_PATH)
  return { ok: true }
}
