'use server'

import { revalidatePath } from 'next/cache'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { RepeatOutcome } from '@/ui/request-view/repeat-rules'
import type { ActionFailure, ActionOutcome } from '@/ui/tasks/outcome'
import { getSession } from '../../../_lib/session'
import { addOrRemoveFollower, answerQuestion, cancelOwnRequest, followOrUnfollow, renewOwnLine, reorderOwnRequest } from '../../_tracking/commands'

// Browser-facing adapters of the actions on /requests/[id]: the requester's (FR-INT-009) answer the approver's question
// and cancel with a reason; the followers' (FR-INT-013 AC1) follow or stop following, and the requester adds or removes
// a follower. A returned request is sent again from the edit page's last step, which shows its budget, its
// new route and its documents first (§9.9 principle 3; requests/new/actions.ts submitRequestAction). Each checks the
// session and hands the raw input to _tracking/commands.ts, which parses it, keeps the cancel to the requester, and runs
// the service; the services check that the member is the requester and that the request's state allows it (§6.4).
// The requester also asks again (S6-12 · FR-INT-101): a new draft from the request, or from one of its service lines.

const NO_SESSION: ActionFailure = { ok: false, code: 'UNAUTHENTICATED' }

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

export async function followAction(input: { requestId: string; follow: boolean }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await followOrUnfollow(ctx, input, idempotencyKey))
}

export async function manageFollowerAction(input: { requestId: string; memberId: string; follow: boolean }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  return refreshed(await addOrRemoveFollower(ctx, input, idempotencyKey))
}

/** "ขอซ้ำ" (FR-INT-101 AC1): a new draft from the requester's request; the screen opens its edit page */
export async function reorderAction(requestId: string, idempotencyKey: string): Promise<RepeatOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await reorderOwnRequest(ctx, requestId, idempotencyKey)
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

/** "สร้างคำขอต่ออายุ" (FR-INT-101 AC2): a new draft from one service line of the requester's request */
export async function renewLineAction(requestLineId: string, idempotencyKey: string): Promise<RepeatOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  const outcome = await renewOwnLine(ctx, requestLineId, idempotencyKey)
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}
