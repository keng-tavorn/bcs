import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { kpiView } from '@/server/services/reports/screens'
import { Button } from '@/ui/form/button'
import { Field } from '@/ui/form/field'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { ExportPanel } from '@/ui/insight/export-panel'
import { daysInPeriod } from '@/ui/insight/format'
import { KpiTable } from '@/ui/insight/kpi-table'
import { Refused } from '@/ui/insight/refused'
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
    <div className="flex flex-col gap-6">
      <div className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
        <p className="font-medium text-ink">{t('periodLine', { from: dayText(locale, period.from), to: dayText(locale, period.to), days: daysInPeriod(period.from, period.to) })}</p>
        <p className="text-base text-ink-muted md:text-sm">{t('asOf', { time: formatDateTime(locale, asOf) })}</p>
      </div>

      <form key={query} method="get" action="/kpi" className="flex flex-col gap-3 border-y border-line py-4 md:flex-row md:items-end">
        <div className="md:w-56">
          <Field id="kpi-from" name="from" type="date" label={t('from')} defaultValue={period.from} required />
        </div>
        <div className="md:w-56">
          <Field id="kpi-to" name="to" type="date" label={t('to')} defaultValue={period.to} required />
        </div>
        <Button type="submit" variant="secondary" className="self-start md:self-auto">
          {t('show')}
        </Button>
      </form>
      {period.invalid ? <Notice tone="warning">{t('periodInvalid', { days: KPI_REVIEW_DAYS })}</Notice> : null}

      {baseline ? null : (
        <Notice tone="info">
          <p className="font-medium">{t('baseline.noneTitle')}</p>
          <p>{t('baseline.noneHint')}</p>
        </Notice>
      )}

      <section aria-labelledby="kpi-figures" className="flex flex-col gap-3">
        <h2 id="kpi-figures" className="text-xl font-semibold">
          {t('figuresTitle')}
        </h2>
        <p className="text-base text-ink-muted md:text-sm">{t('figuresHint')}</p>
        <KpiTable
          goals={goals}
          labels={{ caption: t('table.caption'), measure: t('table.measure'), value: t('table.value'), baseline: t('table.baseline'), target: t('table.target') }}
        />
      </section>

      <section aria-labelledby="kpi-export" className="flex max-w-4xl flex-col gap-3 border-t border-line pt-6">
        <h2 id="kpi-export" className="text-xl font-semibold">
          {t('export.title')}
        </h2>
        <p className="text-ink-muted">{t('export.hint')}</p>
        <ExportPanel endpoint="/reports/export" payload={{ reportCode: 'KPI', params: { from: period.from, to: period.to } }} formats={['csv']} open={downloadUrlAction} />
      </section>
    </div>
  )
}
