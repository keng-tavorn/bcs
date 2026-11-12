import { z } from 'zod'
import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { planReviewTaskSla, runReviewTaskTimer } from '@/server/services/risk'
import { timerStep, whenDue, type TimerStep } from './approval-task-sla'

// Job risk-review-task-sla (S11-06 · BR-SLA-02 · BR-RSK-07 · FR-RSK-202 AC5): from a reviewer's task assigned it sleeps
// until remindAt and reminds the reviewer, until dueAt and tells them it is overdue, until escalateAt and tells the
// fallback of the slot's rule for their information (no co-reviewer: a reviewer has no next band). A decision or a
// cancel ends the run; each timer reads the task again and leaves a closed one alone. A move after an org change keeps
// the task and its times (review_task.reassigned), so the run goes on and tells the new holder.

const Payload = z.object({ organizationId: z.uuid(), aggregateId: z.uuid() })
const SAME_TASK = 'async.data.aggregateId == event.data.aggregateId'

export interface ReviewTaskSlaRun {
  readonly taskId: string
  readonly reminded: boolean
  readonly overdue: boolean
  readonly escalated: boolean
  readonly stopped: string | null
}

export function riskReviewTaskSlaHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep): Promise<ReviewTaskSlaRun | 'IGNORED'> => {
    const payload = Payload.safeParse(event.data)
    if (!payload.success) return 'IGNORED'
    const { organizationId, aggregateId: taskId } = payload.data
    const plan = await step.run('plan', () => planReviewTaskSla(organizationId, taskId))
    const run = { taskId, reminded: false, overdue: false, escalated: false }
    if (!plan.open || !plan.dueAt) return { ...run, stopped: 'CLOSED' }
    const timer = (kind: 'REMIND' | 'OVERDUE' | 'ESCALATE') => () => runReviewTaskTimer(organizationId, taskId, kind, clock.now())
    let reminded = false
    if (plan.remindAt) {
      const r = await whenDue(step, 'remind', plan.remindAt, timer('REMIND'))
      if (!r.done && r.reason !== 'NOT_DUE') return { ...run, stopped: r.reason }
      reminded = r.done
    }
    const overdue = await whenDue(step, 'overdue', plan.dueAt, timer('OVERDUE'), 'until-due')
    if (!overdue.done) return { ...run, reminded, stopped: overdue.reason }
    if (!plan.escalateAt) return { ...run, reminded, overdue: true, stopped: null }
    const escalated = await whenDue(step, 'escalate', plan.escalateAt, timer('ESCALATE'))
    return { ...run, reminded, overdue: true, escalated: escalated.done, stopped: escalated.done ? null : escalated.reason }
  }
}

export const riskReviewTaskSla = inngest.createFunction(
  {
    id: 'risk-review-task-sla',
    triggers: [{ event: 'bcs/review_task.assigned' }],
    cancelOn: [
      { event: 'bcs/review_task.decided', if: SAME_TASK },
      { event: 'bcs/review_task.cancelled', if: SAME_TASK },
    ],
  },
  async ({ event, step }) => riskReviewTaskSlaHandler(systemClock)(event, timerStep(step)),
)
