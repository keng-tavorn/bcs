import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { listMyRequests } from '@/server/queries/requests'
import { listMyTasks, type InboxTaskDto } from '@/server/queries/tasks'
import type { StepBadgeKey } from '@/ui/document/badges'
import { FilterBar, FilterSelect, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { TaskList } from '@/ui/tasks/task-list'
import { getSession } from '../../_lib/session'
import { localeOf } from '../_tracking/present'
import { loadTaskFilters } from '../_tracking/list-filters'
import { taskRows } from '../_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('tasks')
  return { title: t('title') }
}

/**
 * A task's SLA as the step badge of §9.10, as the home's "รอฉันอนุมัติ" reads it (../_tracking/home-present.ts): waiting
 * for the requester's answer, past its due time, or waiting for the decision. The inbox does not carry how much of the
 * SLA is used, so a task on time stays OPEN (never OPEN_HALF).
 */
function slaKey(task: InboxTaskDto): Extract<StepBadgeKey, 'OPEN' | 'OVERDUE' | 'INFO_REQUESTED'> {
  return task.status === 'INFO_REQUESTED' ? 'INFO_REQUESTED' : task.overdue ? 'OVERDUE' : 'OPEN'
}

// The approver's inbox (spec §9.1 /tasks, §9.9 principle 1): every task waiting for this member — theirs and the ones
// they hold for someone while acting for them — those they can decide first, the ones due first at the top, each with
// its SLA as a step badge (§9.10) and the business time it has waited; then those waiting for the requester's answer,
// the question asked first, each with how long it has waited for the answer (listMyTasks). The count reads "1 task",
// "2 tasks" in English (an ICU plural). The list holds only the member's own tasks; deciding is checked again on the
// decision page and in the service. Nothing waiting (§9.9 principle 8), the next step is one the member can take, as on
// home: a member with requests of their own follows them; one with none — an auditor, an approver who never asked for
// anything — is never sent to an empty list of requests, but offered to start one when their role may (the shell's
// door checks the same right). ?due=overdue keeps the tasks past their due time and ?due=info those waiting for an
// answer (the home's row and tabs link here, §9.10), chosen in the filter card (a plain GET form), with the way back to
// all of them.
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, td, locale, { due }] = await Promise.all([
    getTranslations('tasks'),
    getTranslations('requestView'),
    getTranslations('document.badge'),
    getLocale().then(localeOf),
    loadTaskFilters(searchParams),
  ])
  const inbox = await listMyTasks(ctx, { due: due === 'overdue' ? 'OVERDUE' : due === 'info' ? 'INFO' : null })
  const badgeLabel = { OPEN: td('step.OPEN_PLAIN'), OVERDUE: td('step.OVERDUE_PLAIN'), INFO_REQUESTED: td('step.INFO_REQUESTED') } as const
  // The badge says "waiting for the requester's answer"; the row keeps how long it has waited
  const rows = taskRows(t, tv, locale, inbox.items).map((row, i) => {
    const key = slaKey(inbox.items[i]!)
    return { ...row, badge: { key, label: badgeLabel[key] }, states: row.states.filter((s) => s.kind !== 'question') }
  })
  // Only an empty inbox with no filter asks whether the member has requests to follow
  const hasRequests = inbox.items.length || due ? true : (await listMyRequests(ctx, { limit: 1 })).rows.length > 0
  const canRequest = isAllowed(memberPrincipal(state.member.id, state.roles), 'request.create')
  const count = due === 'overdue' ? t('filter.overdue', { count: inbox.total }) : due === 'info' ? t('filter.info', { count: inbox.total }) : t('count', { count: inbox.total })

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        {inbox.total > 0 || due ? (
          <FilterBar
            action="/tasks"
            label={t('filter.label')}
            submit={t('filter.submit')}
            footer={<FilterSummary count={count} clear={due ? { href: '/tasks', label: t('filter.all') } : null} />}
          >
            <FilterSelect
              id="task-due"
              name="due"
              label={t('filter.due')}
              all={t('filter.allTasks')}
              defaultValue={due ?? ''}
              options={[
                { value: 'overdue', label: t('filter.optionOverdue') },
                { value: 'info', label: t('filter.optionInfo') },
              ]}
            />
          </FilterBar>
        ) : null}

        <Panel label={t('listLabel')}>
          {rows.length ? (
            <TaskList label={t('listLabel')} rows={rows} />
          ) : due ? (
            <ListEmpty
              title={due === 'overdue' ? t('filter.emptyOverdue') : t('filter.emptyInfo')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/tasks">{t('filter.all')}</Link>
                </Button>
              }
            />
          ) : (
            <ListEmpty
              title={t('empty')}
              hint={hasRequests ? t('emptyHint') : t('emptyHintNoRequests')}
              actions={
                hasRequests ? (
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href="/requests">{t('emptyLink')}</Link>
                  </Button>
                ) : canRequest ? (
                  <Button asChild className="min-h-11 lg:min-h-10">
                    <Link href="/requests/new">{t('emptyStart')}</Link>
                  </Button>
                ) : undefined
              }
            />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
