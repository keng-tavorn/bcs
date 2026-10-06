'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { getLocale } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { rotateSessionAfterStepUp, type SignedInSession } from '@/server/auth/session-rotation'
import { memberPrincipal } from '@/server/authz'
import type { TaskDecisionInput } from '@/ui/tasks/decision-panel'
import type { ActionOutcome } from '@/ui/tasks/outcome'
import type { PolicyDecisionInput } from '@/ui/tasks/policy-decision'
import { getSession } from '../../_lib/session'
import { askRequester, decidePolicy, decideRequestTask, type StepUpSession } from '../_tracking/commands'
import { localeOf } from '../_tracking/present'

// Browser-facing adapters of the decision page (FR-DOA-004, BR-DOA-15, FR-AUTH-005). Each checks the session and hands
// the raw input to _tracking/commands.ts, which parses it and runs the service; the service checks the assignee
// (approval.decide), the task's state, separation of duties and the step-up again (BR-AUTH-05), so a hidden button is
// never the guard. The idempotencyKey comes from the form (spec §4.3), so the same submission sent twice decides once.
// A decision that needs a step-up carries the PIN: checked on the security clock, then the browser's session id changes
// at once (NFR-SEC-04, src/server/auth/session-rotation.ts) and the decision runs, in this one action. The page this
// action renders again reads the new cookie (src/app/_lib/session.ts).

const NO_SESSION: ActionOutcome = { ok: false, code: 'UNAUTHENTICATED' }

/** Home, the inbox, the request and the bell all change after a decision */
function refreshed(outcome: ActionOutcome): ActionOutcome {
  if (outcome.ok) revalidatePath('/', 'layout')
  return outcome
}

/**
 * The step-up of this request: real time, and a new session id once the PIN was right for the session this request was
 * resolved to (getSession above it, never what the browser sent)
 */
function stepUpSession(signedIn: SignedInSession): StepUpSession {
  return {
    securityNow: systemClock.now(),
    rotateSession: async () => (await rotateSessionAfterStepUp(await headers(), { sessionId: signedIn.sessionId, userId: signedIn.userId })).ok,
  }
}

export async function decideTaskAction(input: TaskDecisionInput, idempotencyKey: string): Promise<ActionOutcome> {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return NO_SESSION
  return refreshed(await decideRequestTask(ctx, input, idempotencyKey, localeOf(await getLocale()), stepUpSession(state)))
}

export async function askForInformationAction(input: { taskId: string; question: string }, idempotencyKey: string): Promise<ActionOutcome> {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return NO_SESSION
  return refreshed(await askRequester(ctx, input, idempotencyKey))
}

/**
 * BR-DOA-15: a DOA version or an authority change is decided with the PIN (security clock); a DOA version with a boundary
 * table is approved with the approver's tick of it and the version it compared with (FR-DOA-009 AC3)
 */
export async function decidePolicyTaskAction(input: PolicyDecisionInput, idempotencyKey: string): Promise<ActionOutcome> {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return NO_SESSION
  return refreshed(await decidePolicy(ctx, memberPrincipal(state.member.id, state.roles), input, idempotencyKey, localeOf(await getLocale()), stepUpSession(state)))
}
