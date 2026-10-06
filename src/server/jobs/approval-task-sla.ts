import { systemClock, type Clock } from '@/lib/clock'
import { MS_PER_SECOND } from '@/lib/constants'
import { inngest } from '@/server/inngest'
import { escalateTask, markTaskOverdue, planTaskSla, remindTaskSla, type TaskSlaPlan } from '@/server/services/sla'

// Job `approval-task-sla` (spec §4.6, BR-SLA-02 to BR-SLA-04, FR-NOTI-003): from the moment a task is assigned — or
// moved to a new holder — it sleeps until remindAt and reminds, until dueAt and marks the task overdue (the assignee and
// the next band's approver are told), until escalateAt and escalates (the next band's approver joins as co-assignee).
// The catalogue has no approval_task.closed or approval_task.paused (§10.2), so a run is cancelled by what closes or
// pauses its task: approval_task.decided, approval_task.cancelled, approval_task.reassigned away from it, and
// request.info_requested on it. The handlers read the task again anyway and leave a closed or paused task alone
// (§4.6 rule 1, FR-NOTI-003 AC3); approval-task-resume plans again once the requester answers (BR-SLA-03).
// A handler that finds its time not come yet (NOT_DUE: the calendar moved it after the plan, or this run woke early by
// the application's clock) says how long is left, and the run waits that long and tries again — a relative wait, so a
// skew between Inngest's clock and the application's cannot end the run. A busy database throws inside the step, and
// Inngest retries it with backoff (src/server/services/sla/step-result.ts).

/** The step tools the timers use; Inngest's step satisfies it, and tests drive it with a fake clock */
export interface TimerStep {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>
  sleepUntil(id: string, at: string): Promise<unknown>
  /** Waits `ms` from now (Inngest's step.sleep) */
  sleep(id: string, ms: number): Promise<unknown>
}

/** How many times one timer waits again for a time that moved or came early before the run gives up on it */
export const TIMER_MAX_WAITS = 8
/** The shortest wait again (Inngest rounds shorter sleeps up to one second) */
const MIN_WAIT_MS = MS_PER_SECOND

/** What every timer step answers: done, or why not, with the time left when it is not due yet */
interface TimerResult {
  readonly done: boolean
  readonly reason?: string | null
  readonly waitMs?: number | null
}

/**
 * Sleeps until `at` (step `sleepId`), then acts (step `name`); while the act answers NOT_DUE, waits the time it says is
 * left and acts again (at most TIMER_MAX_WAITS times). Step ids stay the same from one execution to the next: they
 * follow the memoized results.
 */
export async function whenDue<R extends TimerResult>(step: TimerStep, name: string, at: string, act: () => Promise<R>, sleepId = `until-${name}`): Promise<R> {
  await step.sleepUntil(sleepId, at)
  let result = await step.run(name, act)
  for (let round = 1; round <= TIMER_MAX_WAITS && !result.done && result.reason === 'NOT_DUE' && typeof result.waitMs === 'number'; round++) {
    await step.sleep(`wait-${name}-${round}`, Math.max(result.waitMs, MIN_WAIT_MS))
    result = await step.run(`${name}-${round}`, act)
  }
  return result
}

export interface TaskSlaRun {
  readonly taskId: string
  readonly reminded: boolean
  readonly overdue: boolean
  readonly escalated: 'CO_ASSIGNED' | 'NO_NEXT_BAND' | null
  /** Why the run ended before escalating, when it did */
  readonly stopped: string | null
}

/** Answers that end the run: the task is decided, cancelled, moved, waiting for the requester, or its due time moved */
const ENDS_RUN: ReadonlySet<string> = new Set(['CLOSED', 'PAUSED', 'NOT_FOUND', 'STALE'])

/** The timers of one task after its plan (shared by approval-task-sla and approval-task-resume) */
export async function runTaskSlaTimers(step: TimerStep, organizationId: string, plan: TaskSlaPlan, clock: Clock): Promise<TaskSlaRun> {
  const run = { taskId: plan.taskId, reminded: false, overdue: false, escalated: null }
  if (!plan.open || !plan.dueAt) return { ...run, stopped: plan.status }
  let reminded = false
  if (plan.remindAt) {
    const remind = await whenDue(step, 'remind', plan.remindAt, () => remindTaskSla(organizationId, plan.taskId, clock.now()))
    if (!remind.done && remind.reason && ENDS_RUN.has(remind.reason)) return { ...run, stopped: remind.reason }
    reminded = remind.done
  }
  const overdue = await whenDue(step, 'overdue', plan.dueAt, () => markTaskOverdue(organizationId, plan.taskId, clock.now()), 'until-due')
  if (!overdue.escalateAt) return { ...run, reminded, overdue: overdue.done, stopped: overdue.done ? null : overdue.reason }
  const escalated = await whenDue(step, 'escalate', overdue.escalateAt, () => escalateTask(organizationId, plan.taskId, clock.now()))
  return { ...run, reminded, overdue: true, escalated: escalated.outcome, stopped: escalated.done ? null : escalated.reason }
}

/** What Inngest delivers: the outbox payload of approval_task.assigned or approval_task.reassigned (the new task) */
interface TaskEventPayload {
  readonly organizationId: string
  readonly aggregateId: string
}

export function approvalTaskSlaHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep): Promise<TaskSlaRun> => {
    const { organizationId, aggregateId: taskId } = event.data as TaskEventPayload
    const plan = await step.run('plan', () => planTaskSla(organizationId, taskId, clock.now()))
    return runTaskSlaTimers(step, organizationId, plan, clock)
  }
}

/** Inngest's step as the timers' step tools: every result the handlers return is plain JSON already */
export function timerStep(step: {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>
  sleepUntil: (id: string, at: string) => Promise<unknown>
  sleep: (id: string, ms: number) => Promise<unknown>
}): TimerStep {
  return {
    run: <T>(id: string, fn: () => Promise<T>) => step.run(id, fn) as Promise<T>,
    sleepUntil: (id, at) => step.sleepUntil(id, at),
    sleep: (id, ms) => step.sleep(id, ms),
  }
}

const SAME_TASK = 'async.data.aggregateId == event.data.aggregateId'

export const approvalTaskSla = inngest.createFunction(
  {
    id: 'approval-task-sla',
    triggers: [{ event: 'bcs/approval_task.assigned' }, { event: 'bcs/approval_task.reassigned' }],
    cancelOn: [
      { event: 'bcs/approval_task.decided', if: SAME_TASK },
      { event: 'bcs/approval_task.cancelled', if: SAME_TASK },
      { event: 'bcs/approval_task.reassigned', if: 'async.data.data.fromTaskId == event.data.aggregateId' },
      { event: 'bcs/request.info_requested', if: 'async.data.data.taskId == event.data.aggregateId' },
    ],
  },
  async ({ event, step }) => approvalTaskSlaHandler(systemClock)(event, timerStep(step)),
)
