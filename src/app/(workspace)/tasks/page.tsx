import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { listMyRequests } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { TaskList } from '@/ui/tasks/task-list'
import { getSession } from '../../_lib/session'
import { localeOf } from '../_tracking/present'
import { loadTaskFilters } from '../_tracking/list-filters'
import { taskRows } from '../_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('tasks')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// The approver's inbox (spec §9.1 /tasks, §9.9 principle 1): every task waiting for this member — theirs and the ones
// they hold for someone while acting for them — those they can decide first, the ones due first at the top, each with
// the business time it has waited; then those waiting for the requester's answer, the question asked first, each with
// how long it has waited for the answer (listMyTasks). The count reads "1 task", "2 tasks" in English (an ICU plural).
// The list holds only the member's own tasks; deciding is checked again on the decision page and in the service.
// Nothing waiting (§9.9 principle 8), the next step is one the member can take, as on home: a member with requests of
// their own follows them; one with none — an auditor, an approver who never asked for anything — is never sent to an
// empty list of requests, but offered to start one when their role may (the shell's door checks the same right).
// ?due=overdue keeps the tasks past their due time and ?due=info those waiting for an answer (the home's row and tabs
// link here, §9.10), with the way back to all of them.
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tv, locale, { due }] = await Promise.all([getTranslations('tasks'), getTranslations('requestView'), getLocale().then(localeOf), loadTaskFilters(searchParams)])
  const inbox = await listMyTasks(ctx, { due: due === 'overdue' ? 'OVERDUE' : due === 'info' ? 'INFO' : null })
  if (due) {
    return (
      <div className="flex max-w-4xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="font-medium text-ink" role="status">
            {due === 'overdue' ? t('filter.overdue', { count: inbox.total }) : t('filter.info', { count: inbox.total })}
          </p>
          <Link href="/tasks" className={linkClass}>
            {t('filter.all')}
          </Link>
        </div>
        {inbox.items.length ? (
          <TaskList label={t('listLabel')} rows={taskRows(t, tv, locale, inbox.items)} />
        ) : (
          <p className="border-y border-line py-6 font-medium text-ink">{due === 'overdue' ? t('filter.emptyOverdue') : t('filter.emptyInfo')}</p>
        )}
      </div>
    )
  }
  // Only an empty inbox asks whether the member has requests to follow
  const hasRequests = inbox.items.length ? true : (await listMyRequests(ctx, { limit: 1 })).rows.length > 0
  const canRequest = isAllowed(memberPrincipal(state.member.id, state.roles), 'request.create')

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
        {inbox.total > 0 ? <p className="font-medium text-ink">{t('count', { count: inbox.total })}</p> : null}
      </div>
      {inbox.items.length ? (
        <TaskList label={t('listLabel')} rows={taskRows(t, tv, locale, inbox.items)} />
      ) : (
        <div className="flex flex-col gap-2 border-y border-line py-6">
          <p className="font-medium text-ink">{t('empty')}</p>
          <p className="text-ink-muted">{hasRequests ? t('emptyHint') : t('emptyHintNoRequests')}</p>
          {hasRequests ? (
            <Link href="/requests" className={linkClass}>
              {t('emptyLink')}
            </Link>
          ) : canRequest ? (
            <Link href="/requests/new" className={linkClass}>
              {t('emptyStart')}
            </Link>
          ) : null}
        </div>
      )}
    </div>
  )
}
