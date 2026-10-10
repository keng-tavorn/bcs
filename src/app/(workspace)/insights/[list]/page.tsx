import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { INSIGHT_LISTS, insightsList, type InsightList } from '@/server/services/reports/insights'
import { daysInPeriod } from '@/ui/insight/format'
import { KpiItems } from '@/ui/insight/kpi-items'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { linkRights } from '../../board/_rights'
import { channelText, dayText, itemViews, listTitle, queryOf } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('insights')
  return { title: t('list.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// The documents behind one figure of /insights (spec §9.9: every number opens its list; FR-VIS-007 AC3), with the same
// period, department and type as the card — the list is as long as the figure. insightsList checks report.view, and
// po.view over the organization or budget.view for the lists of POs and budget lines, as the cards do (AC4). Each
// document links to its page for readers who may open it; the pages check again.
export default async function InsightListPage({ params, searchParams }: { params: Promise<{ list: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, locale, { list }, sp] = await Promise.all([getTranslations('insights'), getLocale(), params, searchParams])
  if (!(INSIGHT_LISTS as readonly string[]).includes(list)) {
    return (
      <Page>
        <Link href="/insights" className={linkClass}>
          {t('list.back')}
        </Link>
        <PageHeader title={t('list.metaTitle')} />
        <PageBody>
          <Panel>
            <EmptyState title={t('list.unknown')} hint={t('list.noneHint')} href="/insights" linkLabel={t('list.back')} />
          </Panel>
        </PageBody>
      </Page>
    )
  }
  const result = await insightsList(ctx, sp, list)
  if (!result.ok) {
    const capability = result.error.code === 'FORBIDDEN' && typeof result.error.details?.reason === 'string'
    return <Refused title={t('title')} message={capability ? t('list.forbidden') : t('forbidden')} href={capability ? '/insights' : '/'} linkLabel={capability ? t('list.back') : t('home')} />
  }
  const d = result.data
  const back = `/insights${queryOf(d.filters)}`
  const title = d.channel ? t('list.channelOf', { channel: channelText(t, d.channel) }) : d.week ? t('list.weekOf', { date: dayText(locale, d.week) }) : listTitle(t, list as InsightList)
  const department = d.filters.departmentId ? d.options.departments.find((x) => x.id === d.filters.departmentId) : null
  const items = itemViews(t, locale, d.items, linkRights(state.member.id, state.roles))

  return (
    <Page>
      <Link href={back} className={linkClass}>
        {t('list.back')}
      </Link>
      <PageHeader title={title}>
        <p className="font-medium text-ink">
          {t('periodLine', { from: dayText(locale, d.filters.from), to: dayText(locale, d.filters.to), days: daysInPeriod(d.filters.from, d.filters.to) })}
          {department ? ` · ${locale === 'en' ? (department.nameEn ?? department.nameTh) : department.nameTh}` : ''}
        </p>
        <p className="text-ink">{t('list.total', { count: d.total })}</p>
        {d.total > d.items.length ? <p className="text-base text-ink-muted md:text-sm">{t('list.capped', { shown: d.items.length, total: d.total })}</p> : null}
      </PageHeader>
      <PageBody>
        <Panel className="max-w-4xl">
          {items.length === 0 ? <EmptyState title={t('list.none')} hint={t('list.noneHint')} href={back} linkLabel={t('list.back')} /> : <KpiItems items={items} label={title} />}
        </Panel>
      </PageBody>
    </Page>
  )
}
