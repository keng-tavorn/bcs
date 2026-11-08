import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { supplierReport } from '@/server/services/reports'
import { DateField } from '@/ui/form/date-field'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { ExportPanel } from '@/ui/insight/export-panel'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { ReportTable, type ReportColumnView, type ReportRowView } from '@/ui/insight/report-table'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { dayText } from '../../kpi/_present'
import { SUPPLIER_REPORT, SUPPLIER_REPORT_DAYS, periodFrom } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('supplierReport')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-10'
const sectionTitle = 'text-base font-semibold text-ink'
const STATUSES = ['INVITED', 'DRAFT', 'RETURNED'] as const

// The supplier report (S7-16 · BR-SUP ข้อ 13 · §11.4 G-7 · sub-spec S7 "/reports/suppliers"): for a period (the last 90
// days unless the address says otherwise · an approval comes weeks after its invitation) and within the reader's
// report.view scope (supplierReport checks it), the lower median of the business days from invitation to approval —
// all, filled in by the supplier, filled in by procurement — with the applications it counts, the applications waiting
// past their escalation now, and the suppliers with an expired required document by category; the applications open on
// their own pages, which check the reader's rights again. The numbers come from the code, never from the AI; the table
// exports as Excel with a checksum (report SUP_G7).
export default async function SupplierReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tr, ts, locale] = await Promise.all([getTranslations('supplierReport'), getTranslations('reports'), getTranslations('supplierApplications'), getLocale()])
  const period = periodFrom(await searchParams, ctx.now, SUPPLIER_REPORT_DAYS)
  const result = await supplierReport(ctx, { from: period.from, to: period.to })
  if (!result.ok && result.error.code === 'FORBIDDEN') return <Refused title={t('title')} message={tr('forbidden')} href="/" linkLabel={tr('home')} />
  if (!result.ok && result.error.code === 'MODULE_DISABLED') return <Refused title={t('title')} message={t('moduleOff')} href="/reports" linkLabel={t('back')} />

  const back = (
    <Link href="/reports" className={linkClass}>
      {t('back')}
    </Link>
  )
  const periodForm = (
    <Panel label={t('periodLabel')}>
      <form key={`${period.from}:${period.to}`} method="get" action="/reports/suppliers" className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="md:w-72">
          <DateField id="suppliers-from" name="from" label={tr('params.from')} defaultValue={period.from} required />
        </div>
        <div className="md:w-72">
          <DateField id="suppliers-to" name="to" label={tr('params.to')} defaultValue={period.to} required />
        </div>
        <Button type="submit" variant="outline" className="min-h-11 shrink-0 self-start md:mt-[calc(1lh+0.375rem)] lg:min-h-10">
          {t('run')}
        </Button>
      </form>
      {period.invalid ? <Notice tone="info">{tr('periodInvalid', { days: SUPPLIER_REPORT_DAYS })}</Notice> : null}
    </Panel>
  )

  if (!result.ok) {
    return (
      <Page>
        {back}
        <PageHeader title={t('title')} intro={t('intro')} />
        <PageBody>
          {periodForm}
          <Notice tone="danger">{tr('failed')}</Notice>
        </PageBody>
      </Page>
    )
  }

  const r = result.data
  const days = (value: string | null) => (value === null ? { text: t('noneYet'), empty: true } : { text: t('days', { value }), empty: false })
  const medians = [
    { key: 'all', label: t('median.all'), ...days(r.median.all) },
    { key: 'self', label: t('median.self'), ...days(r.median.self) },
    { key: 'onBehalf', label: t('median.onBehalf'), ...days(r.median.onBehalf) },
  ]
  const approvedColumns: ReportColumnView[] = [
    { key: 'application', header: t('approved.columns.application'), numeric: false },
    { key: 'supplier', header: t('approved.columns.supplier'), numeric: false },
    { key: 'invitedAt', header: t('approved.columns.invitedAt'), numeric: false },
    { key: 'decidedAt', header: t('approved.columns.decidedAt'), numeric: false },
    { key: 'days', header: t('approved.columns.days'), numeric: true },
    { key: 'filledBy', header: t('approved.columns.filledBy'), numeric: false },
  ]
  const approvedRows: ReportRowView[] = r.approved.map((a) => ({
    id: a.applicationId,
    cells: {
      application: { text: a.number ?? t('noNumber'), href: `/suppliers/applications/${a.applicationId}` },
      supplier: { text: a.nameTh },
      invitedAt: { text: formatDateTime(locale, a.invitedAt) },
      decidedAt: { text: formatDateTime(locale, a.decidedAt) },
      days: { text: a.businessDays },
      filledBy: { text: a.filledOnBehalf ? t('filledBy.onBehalf') : t('filledBy.self') },
    },
  }))
  const overdueColumns: ReportColumnView[] = [
    { key: 'application', header: t('overdue.columns.application'), numeric: false },
    { key: 'supplier', header: t('overdue.columns.supplier'), numeric: false },
    { key: 'status', header: t('overdue.columns.status'), numeric: false },
    { key: 'escalatedAt', header: t('overdue.columns.escalatedAt'), numeric: false },
  ]
  const overdueRows: ReportRowView[] = r.overdue.map((o) => ({
    id: o.applicationId,
    cells: {
      application: { text: o.number ?? t('noNumber'), href: `/suppliers/applications/${o.applicationId}` },
      supplier: { text: o.nameTh },
      status: { text: (STATUSES as readonly string[]).includes(o.status) ? ts(`status.${o.status as (typeof STATUSES)[number]}`) : o.status },
      escalatedAt: { text: formatDateTime(locale, o.escalatedAt) },
    },
  }))
  const expiredColumns: ReportColumnView[] = [
    { key: 'category', header: t('expired.columns.category'), numeric: false },
    { key: 'suppliers', header: t('expired.columns.suppliers'), numeric: true },
  ]
  const expiredRows: ReportRowView[] = r.expiredByCategory.map((e) => ({ id: e.category, cells: { category: { text: e.category === '-' ? t('expired.noCategory') : e.category }, suppliers: { text: String(e.suppliers) } } }))

  return (
    <Page>
      {back}
      <PageHeader title={t('title')} intro={t('intro')}>
        <p className="font-medium text-ink">
          {tr('resultLine', { from: dayText(locale, period.from), to: dayText(locale, period.to), scope: tr(`scopeShort.${r.scope}`), time: formatDateTime(locale, ctx.now) })}
        </p>
      </PageHeader>
      <PageBody>
        {periodForm}
        <Panel title={t('median.title')} id="g7">
          <dl aria-label={t('median.title')} className="grid gap-3 md:grid-cols-3">
            {medians.map((m) => (
              <div key={m.key} className="flex flex-col gap-1 rounded-md border border-line p-3">
                <dt className="text-base text-ink-muted md:text-sm">{m.label}</dt>
                <dd className={m.empty ? 'text-ink-muted' : 'text-xl font-semibold text-ink tabular'}>{m.text}</dd>
              </div>
            ))}
          </dl>
          <p className="text-base text-ink-muted md:text-sm">{t('median.hint')}</p>
        </Panel>
        <Panel title={t('approved.title', { count: r.approved.length })} id="approved">
          {approvedRows.length ? (
            <ReportTable caption={t('approved.caption')} columns={approvedColumns} rows={approvedRows} rowHeader={0} lead={2} />
          ) : (
            <EmptyState title={t('approved.emptyTitle')} hint={t('approved.emptyHint')} />
          )}
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className={sectionTitle}>{t('export.title')}</h3>
            <p className="text-base text-ink-muted md:text-sm">{t('export.hint')}</p>
            <ExportPanel endpoint="/reports/export" payload={{ reportCode: SUPPLIER_REPORT, params: { from: period.from, to: period.to } }} formats={['xlsx']} open={downloadUrlAction} />
          </div>
        </Panel>
        <Panel title={t('overdue.title', { count: r.overdue.length })} id="overdue">
          <p className="text-ink-muted">{t('overdue.intro')}</p>
          {overdueRows.length ? <ReportTable caption={t('overdue.caption')} columns={overdueColumns} rows={overdueRows} rowHeader={0} lead={2} /> : <EmptyState title={t('overdue.emptyTitle')} hint={t('overdue.emptyHint')} />}
        </Panel>
        <Panel title={t('expired.title')} id="expired">
          <p className="text-ink-muted">{t('expired.intro')}</p>
          {expiredRows.length ? <ReportTable caption={t('expired.caption')} columns={expiredColumns} rows={expiredRows} rowHeader={0} lead={1} /> : <EmptyState title={t('expired.emptyTitle')} hint={t('expired.emptyHint')} />}
        </Panel>
      </PageBody>
    </Page>
  )
}
