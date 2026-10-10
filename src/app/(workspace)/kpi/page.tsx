import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { kpiView } from '@/server/services/reports/screens'
import { DateField } from '@/ui/form/date-field'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { ExportPanel } from '@/ui/insight/export-panel'
import { daysInPeriod } from '@/ui/insight/format'
import { KpiTable } from '@/ui/insight/kpi-table'
import { Refused } from '@/ui/insight/refused'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { downloadUrlAction } from '../../_lib/file-actions'
import { getSession } from '../../_lib/session'
import { periodFrom } from '../reports/_present'
import { KPI_REVIEW_DAYS, dayText, kpiGoals } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('kpi')
  return { title: t('title') }
}

// The KPI page for executives (spec §9.1 /kpi, §11.4, FR-VIS-003 AC2 AC3, demo scene 9): G-1 to G-5 of the organization
// for a period — 60 days for the review by default — each measure in plain words with its value, the Phase 0 baseline
// (none is recorded yet, and the page says so rather than invent one) and the proposed target; every value opens the
// documents it counts; G-5 in all and per kind of document. kpiView checks report.view over the whole organization; a
// department head reads the KPI report of their departments on /reports. The CSV of the period is for the 60-day review.
export default async function KpiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('kpi'), getLocale()])
  const period = periodFrom(await searchParams, ctx.now, KPI_REVIEW_DAYS)
  const result = await kpiView(ctx, { from: period.from, to: period.to })
  if (!result.ok) {
    const head = result.error.code === 'FORBIDDEN' && result.error.details?.reason === 'ORG_SCOPE'
    return <Refused title={t('title')} message={head ? t('forbiddenHead') : t('forbidden')} href={head ? '/reports' : '/'} linkLabel={head ? t('toReports') : t('home')} />
  }

  const { kpi, baseline, asOf } = result.data
  const query = `?from=${period.from}&to=${period.to}`
  const goals = kpiGoals(t, locale, kpi, baseline, query)

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')}>
        {/* FR-VIS-007 AC4: the KPI page leads to the executive summary, which leads back here from its control card */}
        <Link href="/insights" className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('toInsights')}
        </Link>
        <p className="font-medium text-ink">{t('periodLine', { from: dayText(locale, period.from), to: dayText(locale, period.to), days: daysInPeriod(period.from, period.to) })}</p>
        <p className="text-base text-ink-muted md:text-sm">{t('asOf', { time: formatDateTime(locale, asOf) })}</p>
      </PageHeader>

      <PageBody>
        <Panel label={t('periodLabel')}>
          {/* Each day is picked as day, month and Buddhist-era year, and read back in words (DateField), wide enough for the
              three lists, which give way a little where the row is tight; the button keeps its words on one line, level with
              the lists, a label's line and gap below the top of the row */}
          <form key={query} method="get" action="/kpi" className="flex flex-col gap-3 md:flex-row md:items-start">
            <div className="md:w-72">
              <DateField id="kpi-from" name="from" label={t('from')} defaultValue={period.from} required />
            </div>
            <div className="md:w-72">
              <DateField id="kpi-to" name="to" label={t('to')} defaultValue={period.to} required />
            </div>
            <Button type="submit" variant="outline" className="min-h-11 shrink-0 self-start md:mt-[calc(1lh+0.375rem)] lg:min-h-10">
              {t('show')}
            </Button>
          </form>
        </Panel>
        {/* What the page shows instead of a period it cannot use: plain information in --info, never the --warn of what is
            pending or nearly due (§9.9 token table) */}
        {period.invalid ? <Notice tone="info">{t('periodInvalid', { days: KPI_REVIEW_DAYS })}</Notice> : null}

        {baseline ? null : (
          <Notice tone="info">
            <p className="font-medium">{t('baseline.noneTitle')}</p>
            <p>{t('baseline.noneHint')}</p>
          </Notice>
        )}

        <Panel title={t('figuresTitle')} id="kpi-figures">
          <p className="text-base text-ink-muted md:text-sm">{t('figuresHint')}</p>
          <KpiTable
            goals={goals}
            labels={{ caption: t('table.caption'), measure: t('table.measure'), value: t('table.value'), baseline: t('table.baseline'), target: t('table.target') }}
          />
        </Panel>

        <Panel title={t('export.title')} id="kpi-export" className="max-w-4xl">
          <p className="text-ink-muted">{t('export.hint')}</p>
          <ExportPanel endpoint="/reports/export" payload={{ reportCode: 'KPI', params: { from: period.from, to: period.to } }} formats={['csv']} open={downloadUrlAction} />
        </Panel>
      </PageBody>
    </Page>
  )
}
