import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listMyRequests } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { RequestList } from '@/ui/request-view/request-list'
import { TaskList } from '@/ui/tasks/task-list'
import { getSession } from '../_lib/session'
import { localeOf } from './_tracking/present'
import { requestRows, taskRows } from './_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('home')
  return { title: t('title') }
}

/** How many tasks and requests the home page shows before "see all" */
const HOME_ROWS = 5
const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// Home, work first (§9.9 principle 1): what waits for my decision — the ones due first — then my requests with where
// each one is now; every count links to its list. Charts come later (S3 budget, S4 board), never before the work.
export default async function HomePage() {
  const state = await getSession()
  if (state.kind !== 'member') return null
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tt, tv, locale] = await Promise.all([getTranslations('home'), getTranslations('tasks'), getTranslations('requestView'), getLocale().then(localeOf)])
  const [tasks, requests] = await Promise.all([listMyTasks(ctx, { limit: HOME_ROWS }), listMyRequests(ctx, { limit: HOME_ROWS })])
  const name = locale === 'en' && state.member.displayNameEn ? state.member.displayNameEn : state.member.displayNameTh

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{t('greeting', { name })}</h1>
        <Link href="/requests/new" className="inline-flex h-11 shrink-0 items-center justify-center self-start rounded-md bg-primary px-4 font-medium text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary)_85%,black)] sm:self-auto">
          {t('newRequest')}
        </Link>
      </div>

      <section aria-labelledby="my-tasks" className="flex flex-col gap-3">
        <h2 id="my-tasks" className="text-xl font-semibold">
          {t('myTasks')}
        </h2>
        {tasks.items.length ? (
          <>
            <TaskList label={t('myTasks')} rows={taskRows(tt, tv, locale, tasks.items)} />
            <Link href="/tasks" className={linkClass}>
              {t('myTasksAll', { count: tasks.total })}
            </Link>
          </>
        ) : (
          <div className="flex flex-col gap-1 border-y border-line py-4">
            <p className="text-ink-muted">{t('myTasksEmpty')}</p>
            <Link href="/requests" className={linkClass}>
              {t('toMyRequests')}
            </Link>
          </div>
        )}
      </section>

      <section aria-labelledby="my-requests" className="flex flex-col gap-3">
        <h2 id="my-requests" className="text-xl font-semibold">
          {t('myRequests')}
        </h2>
        {requests.rows.length ? (
          <>
            <RequestList
              rows={requestRows(tv, locale, requests.rows)}
              labels={{ list: t('myRequests'), request: tv('columns.request'), status: tv('columns.status'), now: tv('columns.now'), amount: tv('columns.amount'), unit: tv('amounts.currency') }}
            />
            <Link href="/requests" className={linkClass}>
              {t('myRequestsAll', { count: requests.total })}
            </Link>
          </>
        ) : (
          <div className="flex flex-col gap-1 border-y border-line py-4">
            <p className="text-ink-muted">{t('myRequestsEmpty')}</p>
            <Link href="/requests/new" className={linkClass}>
              {t('startRequest')}
            </Link>
          </div>
        )}
      </section>
    </div>
  )
}
