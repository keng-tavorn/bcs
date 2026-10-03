'use server'

import { revalidatePath } from 'next/cache'
import { getLocale } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { memberPrincipal } from '@/server/authz'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import { getSession } from '../../_lib/session'
import { askRequester, decidePolicy, decideRequestTask } from '../_tracking/commands'
import { localeOf } from '../_tracking/present'

// Browser-facing adapters of the decision page (FR-DOA-004, BR-DOA-15). Each checks the session and hands the raw input
// to _tracking/commands.ts, which parses it and runs the service; the service checks the assignee (approval.decide), the
// task's state and separation of duties again (BR-AUTH-05), so a hidden button is never the guard. The idempotencyKey
// comes from the form (spec §4.3), so the same submission sent twice decides once.

const NO_SESSION: ActionOutcome = { ok: false, code: 'UNAUTHENTICATED' }

/** Home, the inbox, the request and the bell all change after a decision */
function refreshed(outcome: ActionOutcome): ActionOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

export async function decideTaskAction(input: { taskId: string; decision: 'APPROVE' | 'RETURN' | 'REJECT'; reason?: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  return refreshed(await decideRequestTask(ctx, input, idempotencyKey, localeOf(await getLocale())))
}

export async function askForInformationAction(input: { taskId: string; question: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  return refreshed(await askRequester(ctx, input, idempotencyKey))
}

/** BR-DOA-15: a DOA version or an authority change is decided with the authenticator code again (security clock) */
export async function decidePolicyTaskAction(input: { taskId: string; decision: 'APPROVE' | 'REJECT'; reason?: string; code: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return NO_SESSION
  return refreshed(await decidePolicy(ctx, memberPrincipal(state.member.id, state.roles), input, idempotencyKey, localeOf(await getLocale()), systemClock.now()))
}
