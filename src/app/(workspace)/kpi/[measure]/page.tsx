import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { KPI_LISTS, kpiDetail, type KpiList } from '@/server/services/reports/screens'
import { daysInPeriod } from '@/ui/insight/format'
import { KpiItems } from '@/ui/insight/kpi-items'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { linkRights } from '../../board/_rights'
import { periodFrom } from '../../reports/_present'
import { KPI_REVIEW_DAYS, cappedSentence, dayText, detailSentence, isKind, kpiItemViews, listTitle } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('kpi')
  return { title: t('items.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// The documents behind one KPI figure (spec §9.9: every number on the KPI page leads to its list; §11.4): for the same
// period, each decision, task, request or PO the figure counts, with who, when, the channel and the DOA reference, and
// why it is counted — or, behind the "37" of "1 จาก 37 ขั้น" (g3c-steps), every step the share of steps past due
// divides by, the counted ones first. kpiDetail checks report.view over the whole organization, like the KPI page.
export default async function KpiItemsPage({ params, searchParams }: { params: Promise<{ measure: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tl, locale, { measure }] = await Promise.all([getTranslations('kpi'), getTranslations('timeline'), getLocale(), params])
  const sp = await searchParams
  const period = periodFrom(sp, ctx.now, KPI_REVIEW_DAYS)
  const askedKind = one(sp.kind)
  const kind = askedKind && isKind(askedKind) ? askedKind : null
  const back = `/kpi?from=${period.from}&to=${period.to}`
  const backLink = (
    <Link href={back} className={linkClass}>
      {t('items.back')}
    </Link>
  )
  if (!(KPI_LISTS as readonly string[]).includes(measure)) {
    return (
      <Page>
        {backLink}
        <PageHeader title={t('items.metaTitle')} />
        <PageBody>
          <Panel>
            <EmptyState title={t('items.unknown')} hint={t('items.unknownHint')} href={back} linkLabel={t('items.back')} />
          </Panel>
        </PageBody>
      </Page>
    )
  }
  const m = measure as KpiList
  const result = await kpiDetail(ctx, { from: period.from, to: period.to }, m, kind)
  if (!result.ok) {
    const head = result.error.code === 'FORBIDDEN' && result.error.details?.reason === 'ORG_SCOPE'
    return <Refused title={t('title')} message={head ? t('forbiddenHead') : t('forbidden')} href={head ? '/reports' : '/'} linkLabel={head ? t('toReports') : t('home')} />
  }
  const d = result.data
  const { name, formula } = listTitle(t, m, kind)
  const items = kpiItemViews(t, tl, locale, m, d.items, linkRights(state.member.id, state.roles))

  return (
    <Page>
      {backLink}
      <PageHeader title={name} intro={formula}>
        <p className="font-medium text-ink">{t('periodLine', { from: dayText(locale, period.from), to: dayText(locale, period.to), days: daysInPeriod(period.from, period.to) })}</p>
        <p className="text-ink">{detailSentence(t, d)}</p>
        {cappedSentence(t, d) ? <p className="text-base text-ink-muted md:text-sm">{cappedSentence(t, d)}</p> : null}
      </PageHeader>
      <PageBody>
        <Panel className="max-w-4xl">
          {items.length === 0 ? (
            <EmptyState title={t('items.none')} hint={t('items.noneHint')} href={back} linkLabel={t('items.back')} />
          ) : (
            <KpiItems items={items} label={t('items.listLabel', { name })} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
