'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import { getSession } from '../../../_lib/session'
import { answerQuestion, cancelOwnRequest } from '../../_tracking/commands'

// Browser-facing adapters of the requester's actions on /requests/[id] (FR-INT-009): answer the approver's question,
// cancel with a reason. A returned request is sent again from the edit page's last step, which shows its budget, its
// new route and its documents first (§9.9 principle 3; requests/new/actions.ts submitRequestAction). Each checks the
// session and hands the raw input to _tracking/commands.ts, which parses it, keeps the cancel to the requester, and runs
// the service; the services check that the member is the requester and that the request's state allows it (§6.4).

const NO_SESSION: ActionOutcome = { ok: false, code: 'UNAUTHENTICATED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function refreshed(outcome: ActionOutcome): ActionOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function answerInfoAction(input: { infoRequestId: string; answer: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await answerQuestion(ctx, input, idempotencyKey))
}

export async function cancelRequestAction(input: { requestId: string; reason: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await cancelOwnRequest(ctx, input, idempotencyKey))
}
