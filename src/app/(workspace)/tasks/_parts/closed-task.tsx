import type { getTranslations } from 'next-intl/server'
import type { TaskViewDto } from '@/server/queries/tasks'
import { memberName, when, type Locale } from '../../_tracking/present'

// What a decision page says of a task that closed without a decision of its own (spec §6.4, FR-DOA-004 AC2, §9.3): it
// moved to someone else, or it was cancelled and why — and, when another task of its step decided the step (the other
// approver of an escalated step decided first, BR-SLA-04, or the delegate it moved to decided it), who decided and when
// (TaskViewDto.stepDecision), in the reader's language. The web decision page and the LIFF one put the same words in
// their own notice.

type TasksT = Awaited<ReturnType<typeof getTranslations<'tasks'>>>

/** "อนุมัติแล้วโดย … เมื่อ …" of the decision another task of the step made; null when nothing on the step closed it */
export function stepDecisionText(t: TasksT, locale: Locale, task: Pick<TaskViewDto, 'stepDecision'>): string | null {
  const decided = task.stepDecision
  return decided ? t(`state.${decided.decision ?? 'APPROVE'}`, { name: memberName(locale, decided.decidedBy), time: when(locale, decided.decidedAt) }) : null
}

/** The words inside the notice of a moved or cancelled task: why it closed, then who decided its step and when */
export function ClosedTaskText({ task, t, locale }: { task: TaskViewDto; t: TasksT; locale: Locale }) {
  const why =
    task.status === 'REASSIGNED'
      ? task.reassignedTo
        ? t('state.reassigned', { name: memberName(locale, task.reassignedTo) })
        : t('state.reassignedUnknown')
      : t(`state.cancelled.${task.cancelledWhy ?? 'other'}`)
  const decided = stepDecisionText(t, locale, task)
  return (
    <>
      <p>{why}</p>
      {decided ? <p>{decided}</p> : null}
    </>
  )
}
