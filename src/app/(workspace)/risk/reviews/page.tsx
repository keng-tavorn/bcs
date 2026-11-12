import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskReviewTasks } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { STEP_BADGES } from '@/ui/document/badges'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { REVIEW_TASK_BADGES, reviewDueState, slotDomains } from '@/ui/risk-review/model'
import { ReviewTabs } from '@/ui/risk-review/review-tabs'
import { ReviewTaskList, type ReviewTaskRowUi } from '@/ui/risk-review/task-list'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { localeOf, when } from '../../_tracking/present'

export async function generateMetadata() {
  const t = await getTranslations('riskReview.list')
  return { title: t('title') }
}

// /risk/reviews (S11-06 · FR-RSK-202 AC3 · BR-RSK-07): the supplier risk assessments a member reviews a part of. รอตรวจ
// lists the tasks they may decide now — their own, those that fell to them, and those of a holder they act for — the
// one due first on top, each with its due state as the step badge of §9.10; ตรวจแล้ว lists the ones they decided, the
// latest first, with how. The list is the member's own (risk.review.view); the task page and the decision check again.
// Nothing waiting (§9.9 rule 8) points at the other tab.

type Tab = 'open' | 'done'

export default async function RiskReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const wanted = (await searchParams).tab
  const tab: Tab = (Array.isArray(wanted) ? wanted[0] : wanted) === 'done' ? 'done' : 'open'
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('riskReview'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const listed = await riskReviewTasks(ctx, tab === 'done' ? 'DONE' : 'OPEN')
  if (!listed.ok) return <NoAccess title={t('list.title')} message={listed.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />

  const rows: ReviewTaskRowUi[] = listed.data.map((r) => {
    const due = reviewDueState(ctx.now, r.assignedAt, r.dueAt)
    const decided = r.status !== 'OPEN'
    return {
      taskId: r.taskId,
      href: `/risk/reviews/${r.taskId}`,
      title: t('list.row', { number: r.number ?? r.supplier.code, supplier: r.supplier.nameTh }),
      meta: t('list.rowDomains', { domains: slotDomains(r.riskDomains).map((d) => tAdmin(`domain.${d}`)).join(' · ') }),
      tier: r.tier ? { code: r.tier, label: t(`tier.${r.tier}`) } : null,
      badge: decided
        ? { look: REVIEW_TASK_BADGES[r.status as Exclude<typeof r.status, 'OPEN'>], label: t(`taskStatus.${r.status}`) }
        : { look: STEP_BADGES[due], label: due === 'OVERDUE' ? t('due.overdue', { time: when(locale, r.dueAt) }) : t('due.open', { time: when(locale, r.dueAt) }) },
      when: decided && r.decidedAt ? t('list.decidedAt', { time: when(locale, r.decidedAt) }) : t('list.assignedAt', { time: when(locale, r.assignedAt) }),
      onBehalfOf: r.onBehalfOfName ? t('list.onBehalfOf', { name: r.onBehalfOfName }) : null,
    }
  })

  return (
    <Page>
      <PageHeader title={t('list.title')} intro={t('list.intro')} />
      <PageBody>
        <Panel label={t('list.tabs')}>
          <ReviewTabs
            label={t('list.tabs')}
            current={tab}
            tabs={[
              { key: 'open', label: t('list.tabOpen'), href: '/risk/reviews' },
              { key: 'done', label: t('list.tabDone'), href: '/risk/reviews?tab=done' },
            ]}
          >
            {rows.length ? (
              <>
                <p className="text-ink-muted">{tab === 'done' ? t('list.countDone', { count: rows.length }) : t('list.countOpen', { count: rows.length })}</p>
                <ReviewTaskList label={tab === 'done' ? t('list.tabDone') : t('list.tabOpen')} rows={rows} />
              </>
            ) : (
              <ListEmpty
                title={tab === 'done' ? t('list.emptyDone') : t('list.emptyOpen')}
                hint={tab === 'done' ? t('list.emptyDoneHint') : t('list.emptyOpenHint')}
                actions={
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href={tab === 'done' ? '/risk/reviews' : '/risk/reviews?tab=done'}>{tab === 'done' ? t('list.emptyDoneLink') : t('list.emptyOpenLink')}</Link>
                  </Button>
                }
              />
            )}
          </ReviewTabs>
        </Panel>
      </PageBody>
    </Page>
  )
}
