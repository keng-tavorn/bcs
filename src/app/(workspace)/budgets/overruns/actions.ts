'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { cancelBudgetOverrun, submitBudgetOverrun } from '@/server/services/budget/overruns'
import { toOverrunFailure, type OverrunFailure, type OverrunOutcome } from '@/ui/budgets/overrun-model'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of over-budget approval (S6-16 · FR-BUD-101): asked from the request page by its requester,
// cancelled there or on /budgets/overruns/[id]. Each builds ctx from the session and hands the browser's arguments to a
// service, which parses them and checks budget.overrun.submit, the requester, the request's state, the line and the DOA
// in effect every time (BR-AUTH-05): hiding a button is never the guard. Each call carries its own idempotencyKey from
// the screen (spec §4.3), so a double click or a retry runs the command once (INV-PLT-01).

const NO_SESSION: OverrunFailure = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: OverrunFailure = { ok: false, code: 'VALIDATION_FAILED', field: 'idempotencyKey' }
const submissionKey = z.uuid()

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function refresh() {
  // The request page, the budget figures, the inbox and the overrun's own page all change with every command
  revalidatePath('/', 'layout')
}

export async function submitBudgetOverrunAction(input: { requestId: string; reason: string }, idempotencyKey: string): Promise<OverrunOutcome<{ overrunId: string; number: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(input.requestId).success) return { ok: false, code: 'NOT_FOUND' }
  const r = await submitBudgetOverrun(ctx, { requestId: input.requestId, reason: input.reason }, { idempotencyKey })
  if (!r.ok) return toOverrunFailure(r.error)
  refresh()
  return { ok: true, overrunId: r.data.overrunId, number: r.data.number }
}

export async function cancelBudgetOverrunAction(overrunId: string, idempotencyKey: string): Promise<OverrunOutcome<{ overrunId: string }>> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(idempotencyKey).success) return BAD_KEY
  if (!z.uuid().safeParse(overrunId).success) return { ok: false, code: 'NOT_FOUND' }
  const r = await cancelBudgetOverrun(ctx, { overrunId }, { idempotencyKey })
  if (!r.ok) return toOverrunFailure(r.error)
  refresh()
  return { ok: true, overrunId: r.data.overrunId }
}
