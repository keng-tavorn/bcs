import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { isAllowed, memberPrincipal } from '@/server/authz'
import { listMyRequests } from '@/server/queries/requests'
import { listMyTasks } from '@/server/queries/tasks'
import { listPool } from '@/server/services/procurement'
import { RequestList } from '@/ui/request-view/request-list'
import { TaskList } from '@/ui/tasks/task-list'
import { getSession } from '../_lib/session'
import { poolRow } from './_tracking/pool-row'
import { localeOf } from './_tracking/present'
import { requestRows, taskRows } from './_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('home')
  return { title: t('title') }
}

/** How many tasks and requests the home page shows before "see all" */
const HOME_ROWS = 5
const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// Home, work first (§9.9 principle 1): what waits for my decision — the ones due first, and for procurement the pool of
// approved requests nobody has ordered yet — then my requests with where each one is now; every count links to its list.
// Charts come later (S3 budget, S4 board), never before the work.
export default async function HomePage() {
  const state = await getSession()
  if (state.kind !== 'member') return null
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tt, tv, locale] = await Promise.all([getTranslations('home'), getTranslations('tasks'), getTranslations('requestView'), getLocale().then(localeOf)])
  // The pool is read only by those whose menu has it (the same check, §2.4 procurement.pool.view); listPool checks again
  const seesPool = isAllowed(memberPrincipal(state.member.id, state.roles), 'procurement.pool.view')
  const [tasks, requests, pool] = await Promise.all([listMyTasks(ctx, { limit: HOME_ROWS }), listMyRequests(ctx, { limit: HOME_ROWS }), seesPool ? listPool(ctx) : null])
  const poolWork = pool?.ok ? poolRow(t, pool.data) : null
  // One answer for both sections, so they never disagree: only a member whose requests are listed below has progress to
  // follow; one with none is not sent to an empty list, and their next step is the start link of "my requests" (§9.9
  // principle 8)
  const hasRequests = requests.rows.length > 0
  const name = locale === 'en' && state.member.displayNameEn ? state.member.displayNameEn : state.member.displayNameTh

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      {/* The door to a new request is the shell's, on every page (§9.9 principle 2) */}
      <h1 className="text-2xl font-semibold">{t('greeting', { name })}</h1>

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
        ) : null}
        {poolWork ? <TaskList label={t('pool.list')} rows={[poolWork]} /> : null}
        {!tasks.items.length && !poolWork ? (
          <div className="flex flex-col gap-1 border-y border-line py-4">
            <p className="text-ink-muted">{t('myTasksEmpty')}</p>
            {hasRequests ? (
              <Link href="/requests" className={linkClass}>
                {t('toMyRequests')}
              </Link>
            ) : null}
          </div>
        ) : null}
      </section>

      <section aria-labelledby="my-requests" className="flex flex-col gap-3">
        <h2 id="my-requests" className="text-xl font-semibold">
          {t('myRequests')}
        </h2>
        {hasRequests ? (
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
