import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { runReport } from '@/server/services/reports'
import { reportCatalog } from '@/server/services/reports/screens'
import { DateField } from '@/ui/form/date-field'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { ExportPanel } from '@/ui/insight/export-panel'
import { Refused } from '@/ui/insight/refused'
import { ReportTable } from '@/ui/insight/report-table'
import { ScheduleForm } from '@/ui/insight/schedule-form'
import { downloadUrlAction } from '../../_lib/file-actions'
import { getSession } from '../../_lib/session'
import { dayText } from '../kpi/_present'
import { DEFAULT_REPORT_DAYS, columnViews, isNamed, periodFrom, rowViews } from './_present'
import { createScheduleAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('reports')
  return { title: t('title') }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

// The report framework (spec §9.1 /reports, §11.3, FR-VIS-002 AC1 AC3): the reports the system offers with their
// filters, the result read within the reader's report.view scope (the whole organization for FINANCE, PROCUREMENT,
// EXECUTIVE and AUDITOR, the departments a head heads), its Excel file with a checksum, and — for report.schedule
// (FINANCE, EXECUTIVE) — e-mails on a schedule. The first report is the KPI view of §11.4; the seven reports of the
// proposal (R-01 to R-07) wait for the customer's list (OQ-09) and are never guessed here.
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, locale] = await Promise.all([getTranslations('reports'), getLocale()])
  const catalog = await reportCatalog(ctx)
  if (!catalog.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />

  const params = await searchParams
  const reports = catalog.data.reports
  const asked = one(params.report)
  const report = reports.find((r) => r.code === asked) ?? reports[0]
  const name = (code: string) => (isNamed(code) ? t(`catalog.${code}.name`) : code)
  const period = periodFrom(params, ctx.now, DEFAULT_REPORT_DAYS)
  const result = report ? await runReport(ctx, report.code, { from: period.from, to: period.to }) : null

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')}>
        <p className="font-medium text-ink">{t(`scope.${catalog.data.scope}`)}</p>
      </PageHeader>

      <PageBody>
        <Panel title={t('catalogTitle')} id="reports-catalog" className="max-w-4xl">
          <ul className="flex flex-col divide-y divide-line">
            {reports.map((r) => (
              <li key={r.code} className="flex flex-col gap-1 py-3">
                <Link href={`/reports?report=${r.code}`} aria-current={r.code === report?.code ? 'page' : undefined} className="inline-flex min-h-11 items-center self-start font-semibold text-primary underline underline-offset-4 hover:no-underline lg:min-h-10">
                  {name(r.code)}
                </Link>
                {isNamed(r.code) ? <p className="text-ink-muted">{t(`catalog.${r.code}.description`)}</p> : null}
              </li>
            ))}
          </ul>
          <Notice tone="info">{t('proposalReports')}</Notice>
        </Panel>

        {report && result ? (
          <Panel title={name(report.code)} id="reports-result">
            {/* Each day is picked as day, month and Buddhist-era year, and read back in words (DateField), wide enough for
                the three lists, which give way a little where the row is tight; the button keeps its words on one line,
                level with the lists */}
            <form key={`${report.code}:${period.from}:${period.to}`} method="get" action="/reports" className="flex flex-col gap-3 md:flex-row md:items-start">
              <input type="hidden" name="report" value={report.code} />
              {report.params.map((p) => (
                <div key={p.key} className="md:w-72">
                  <DateField id={`report-${p.key}`} name={p.key} label={t(`params.${p.key === 'from' ? 'from' : 'to'}`)} defaultValue={p.key === 'from' ? period.from : period.to} required />
                </div>
              ))}
              <Button type="submit" variant="outline" className="min-h-11 shrink-0 self-start md:mt-[calc(1lh+0.375rem)] lg:min-h-10">
                {t('run')}
              </Button>
            </form>
            {/* The period shown instead of one that cannot be used: information, as on /kpi (§9.9 tokens: --warn is pending) */}
            {period.invalid ? <Notice tone="info">{t('periodInvalid', { days: DEFAULT_REPORT_DAYS })}</Notice> : null}
            {result.ok ? (
              <>
                <p className="text-ink">
                  {t('resultLine', { from: dayText(locale, period.from), to: dayText(locale, period.to), scope: t(`scopeShort.${result.data.scope}`), time: formatDateTime(locale, ctx.now) })}
                </p>
                <ReportTable caption={t('caption', { name: name(report.code) })} columns={columnViews(t, result.data.columns, locale)} rows={rowViews(t, report.code, result.data.rows)} />
                {report.code === 'KPI' ? (
                  <p className="text-base text-ink-muted md:text-sm">
                    {t('kpiHint')}{' '}
                    {catalog.data.scope === 'ORG' ? (
                      <Link href={`/kpi?from=${period.from}&to=${period.to}`} className="font-medium text-primary underline underline-offset-4 hover:no-underline">
                        {t('kpiLink')}
                      </Link>
                    ) : null}
                  </p>
                ) : null}
                <div className="flex max-w-4xl flex-col gap-2 border-t border-line pt-4">
                  <h3 className="text-base font-semibold">{t('exportTitle')}</h3>
                  <p className="text-base text-ink-muted md:text-sm">{t('exportHint')}</p>
                  <ExportPanel endpoint="/reports/export" payload={{ reportCode: report.code, params: { from: period.from, to: period.to } }} formats={['xlsx']} open={downloadUrlAction} />
                </div>
              </>
            ) : (
              <Notice tone="danger">{t('failed')}</Notice>
            )}
          </Panel>
        ) : null}

        {catalog.data.canSchedule ? (
          <Panel title={t('schedule.title')} id="reports-schedules" className="max-w-4xl">
            <p className="text-ink-muted">{t('schedule.intro')}</p>
            {catalog.data.schedules.length ? (
              <ul aria-label={t('schedule.listLabel')} className="flex flex-col divide-y divide-line border-y border-line">
                {catalog.data.schedules.map((s) => (
                  <li key={s.id} className="flex flex-col gap-0.5 py-3">
                    <p className="font-medium text-ink">
                      {t('schedule.item', { name: name(s.reportCode), cadence: s.cadence ? t(`schedule.cadences.${s.cadence}`) : s.cron, format: t(`schedule.formats.${s.format === 'CSV' ? 'csv' : 'xlsx'}`) })}
                    </p>
                    <p className="text-base text-ink-muted md:text-sm">
                      {t('schedule.itemMeta', { count: s.recipientCount, name: locale === 'en' && s.createdBy.nameEn ? s.createdBy.nameEn : s.createdBy.nameTh, time: formatDateTime(locale, s.createdAt) })}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">{t('schedule.none')}</p>
            )}
            <h3 className="border-t border-line pt-4 text-base font-semibold">{t('schedule.formTitle')}</h3>
            <ScheduleForm
              reports={reports.map((r) => ({ code: r.code, name: name(r.code) }))}
              recipients={catalog.data.recipients.map((m) => ({ id: m.id, name: locale === 'en' && m.nameEn ? m.nameEn : m.nameTh, self: m.id === state.member.id }))}
              schedule={createScheduleAction}
            />
          </Panel>
        ) : null}
      </PageBody>
    </Page>
  )
}
