'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { MS_PER_HOUR } from '@/lib/constants'
import { ctxFromSession } from '@/server/auth/session'
import { remindTask } from '@/server/services/board'
import { toInsightFailure, type RemindOutcome } from '@/ui/insight/outcome'
import { getSession } from '../../../_lib/session'

// Browser-facing adapter of the board's manual reminder (FR-VIS-001 AC2). It checks the session; the service checks
// board.pending.view and the board's scope, the task's state and the one-an-hour rule per document again (BR-AUTH-05).
// The idempotencyKey comes from the button (spec §4.3), so the same press sent twice reminds once.

const NO_SESSION: RemindOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_INPUT: RemindOutcome = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const Input = z.object({ taskId: z.uuid(), idempotencyKey: z.uuid() })

export async function remindTaskAction(taskId: string, idempotencyKey: string): Promise<RemindOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  const input = Input.safeParse({ taskId, idempotencyKey })
  if (!input.success) return BAD_INPUT
  const result = await remindTask(ctx, { taskId: input.data.taskId }, { idempotencyKey: input.data.idempotencyKey })
  if (!result.ok) return toInsightFailure(result.error)
  revalidatePath('/board/pending', 'layout')
  return { ok: true, at: ctx.now.toISOString(), nextAt: new Date(ctx.now.getTime() + MS_PER_HOUR).toISOString() }
}
