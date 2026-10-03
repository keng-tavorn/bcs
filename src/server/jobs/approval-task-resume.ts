import { systemClock, type Clock } from '@/lib/clock'
import { inngest } from '@/server/inngest'
import { resumeTaskSla } from '@/server/services/sla'
import { runTaskSlaTimers, timerStep, type TaskSlaRun, type TimerStep } from './approval-task-sla'

// Job `approval-task-resume` (spec §4.6, BR-SLA-03, FR-INT-009 AC3): the requester answered the approver's question, so
// the task is OPEN again and its SLA counts on from the business time that was left (request.provideInfo stored the new
// dueAt, §6.4). The job plans the task's timers again — the reminder moves with the time left too — and runs them like
// approval-task-sla, whose run on this task was cancelled when the question paused it. The catalogue names the answer
// request.info_provided (§10.2), not approval_task.info_provided; its data carries the task.

interface InfoProvidedPayload {
  readonly organizationId: string
  readonly data: { readonly taskId: string }
}

export function approvalTaskResumeHandler(clock: Clock) {
  return async (event: { data: unknown }, step: TimerStep): Promise<TaskSlaRun> => {
    const { organizationId, data } = event.data as InfoProvidedPayload
    const plan = await step.run('resume', () => resumeTaskSla(organizationId, data.taskId, clock.now()))
    return runTaskSlaTimers(step, organizationId, plan, clock)
  }
}

const SAME_TASK = 'async.data.aggregateId == event.data.data.taskId'

export const approvalTaskResume = inngest.createFunction(
  {
    id: 'approval-task-resume',
    triggers: [{ event: 'bcs/request.info_provided' }],
    cancelOn: [
      { event: 'bcs/approval_task.decided', if: SAME_TASK },
      { event: 'bcs/approval_task.cancelled', if: SAME_TASK },
      { event: 'bcs/approval_task.reassigned', if: 'async.data.data.fromTaskId == event.data.data.taskId' },
      { event: 'bcs/request.info_requested', if: 'async.data.data.taskId == event.data.data.taskId' },
    ],
  },
  async ({ event, step }) => approvalTaskResumeHandler(systemClock)(event, timerStep(step)),
)
