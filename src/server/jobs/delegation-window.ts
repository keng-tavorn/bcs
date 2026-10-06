import { StepError } from 'inngest'
import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { endDelegationWindow, returnRevokedDelegationTasks, startDelegationWindow, type WindowStepResult } from '@/server/services/sla'
import { timerStep, whenDue, type TimerStep } from './approval-task-sla'

// Job `delegation-window` (spec §4.6, BR-DLG-04, FR-DOA-006 AC3): a new delegation sleeps until startsAt, when the
// delegator's open tasks move to the delegate, then until endsAt, when what the delegate still holds for the delegator
// moves back; both sides are told each time. A step that wakes before its time by the application's clock waits again
// (whenDue). A start that still fails after Inngest's retries does not cost the end: the run goes on to endsAt, when
// the tasks routing gave the delegate in the meantime (BR-DLG-04) still go back. A revoked delegation cancels the
// sleeping run, and `delegation-revoked` gives its tasks back at once — a revocation ends the period early (NEW-35).

interface DelegationPayload {
  readonly organizationId: string
  readonly aggregateId: string
  readonly data: { readonly startsAt: string; readonly endsAt: string }
}

export interface DelegationWindowRun {
  readonly delegationId: string
  readonly started: WindowStepResult
  readonly ended: WindowStepResult | null
}

/** The start that failed after its retries, as a result (the run goes on to the end) */
const START_FAILED: WindowStepResult = { done: false, code: 'INTERNAL', reason: 'STEP_FAILED', notBefore: null, waitMs: null }

export function delegationWindowHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep): Promise<DelegationWindowRun> => {
    const { organizationId, aggregateId: delegationId, data } = event.data as DelegationPayload
    let started: WindowStepResult
    try {
      started = await whenDue(step, 'start', data.startsAt, () => startDelegationWindow(organizationId, delegationId, clock.now()))
    } catch (error) {
      if (!(error instanceof StepError)) throw error
      started = START_FAILED
    }
    // Revoked or gone: the revocation gave the tasks back (delegation-revoked); nothing is left for the end
    if (!started.done && (started.reason === 'REVOKED' || started.reason === 'NOT_FOUND')) return { delegationId, started, ended: null }
    const ended = await whenDue(step, 'end', data.endsAt, () => endDelegationWindow(organizationId, delegationId, clock.now()))
    return { delegationId, started, ended }
  }
}

export function delegationRevokedHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep): Promise<WindowStepResult> => {
    const { organizationId, aggregateId: delegationId } = event.data as DelegationPayload
    return step.run('return-tasks', () => returnRevokedDelegationTasks(organizationId, delegationId, clock.now()))
  }
}

export const delegationWindow = inngest.createFunction(
  {
    id: 'delegation-window',
    triggers: [{ event: 'bcs/delegation.created' }],
    cancelOn: [{ event: 'bcs/delegation.revoked', if: 'async.data.aggregateId == event.data.aggregateId' }],
  },
  async ({ event, step }) => delegationWindowHandler(systemClock)(event, timerStep(step)),
)

export const delegationRevoked = inngest.createFunction({ id: 'delegation-revoked', triggers: [{ event: 'bcs/delegation.revoked' }] }, async ({ event, step }) =>
  delegationRevokedHandler(systemClock)(event, timerStep(step)),
)
