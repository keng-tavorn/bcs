import { getLocale, getTranslations } from 'next-intl/server'
import { listMyTasks } from '@/server/queries/tasks'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffTaskList } from '@/ui/liff/tasks/task-list'
import { localeOf } from '../../(workspace)/_tracking/present'
import { taskRows } from '../../(workspace)/_tracking/rows'
import { liffHref, liffTaskHref } from '../_lib/links'
import { liffPage } from '../_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('tasks')
  return { title: t('title') }
}

// /liff/tasks (§9.4 "งานรออนุมัติของฉัน เรียงตามกำหนดเวลา", §9.5 the LINKED menu's งานรออนุมัติ, FR-LINE-003 AC1): the
// member's open tasks in the LINE app — the same query and rows as the web inbox (listMyTasks, taskRows), the ones due
// first at the top, each with its document number, amount, who asked for which department, the business time waited,
// when it is due and an overdue mark, and a link to its LIFF decision page. Only the member's own tasks (and the ones they
// hold for someone, or that their delegate holds for them); deciding is checked again on the decision page and in the
// service. Without a member session the gate signs in with LINE first and shows nothing of the organization.
export default async function LiffTasksPage() {
  const [page, t, tv, tLiff, locale] = await Promise.all([liffPage(), getTranslations('tasks'), getTranslations('requestView'), getTranslations('liffTasks'), getLocale().then(localeOf)])
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('title')}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }
  const inbox = await listMyTasks(page.ctx)
  // The rows of the web inbox, each leading to its LIFF decision page instead of the workspace's
  const rows = taskRows(t, tv, locale, inbox.items).map((row) => ({ ...row, href: liffTaskHref(row.id) }))
  const track = liffHref('/requests')

  return (
    <LiffFrame title={t('title')}>
      <LiffContent>
        <div className="flex flex-col gap-1">
          <p className="text-ink-muted">{t('intro')}</p>
          {inbox.total > 0 ? <p className="font-medium text-ink">{t('count', { count: inbox.total })}</p> : null}
        </div>
        {rows.length ? (
          <LiffTaskList rows={rows} label={t('listLabel')} />
        ) : (
          <div className="flex flex-col gap-2 border-y border-line py-5">
            <p className="font-medium text-ink">{t('empty')}</p>
            <p className="text-ink-muted">{tLiff('list.emptyHint')}</p>
            {track ? <LiffLink href={track}>{tLiff('list.emptyLink')}</LiffLink> : null}
          </div>
        )}
      </LiffContent>
    </LiffFrame>
  )
}
