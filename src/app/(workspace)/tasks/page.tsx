import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listMyTasks } from '@/server/queries/tasks'
import { TaskList } from '@/ui/tasks/task-list'
import { getSession } from '../../_lib/session'
import { localeOf } from '../_tracking/present'
import { taskRows } from '../_tracking/rows'

export async function generateMetadata() {
  const t = await getTranslations('tasks')
  return { title: t('title') }
}

// The approver's inbox (spec §9.1 /tasks, §9.9 principle 1): every task waiting for this member — theirs and the ones
// they hold for someone while acting for them — the ones due first at the top, each with the business time it has
// waited. The list holds only the member's own tasks; deciding is checked again on the decision page and in the service.
export default async function TasksPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tv, locale] = await Promise.all([getTranslations('tasks'), getTranslations('requestView'), getLocale().then(localeOf)])
  const inbox = await listMyTasks(ctx)

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
          <p className="text-ink-muted">{t('emptyHint')}</p>
          <Link href="/requests" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {t('emptyLink')}
          </Link>
        </div>
      )}
    </div>
  )
}
