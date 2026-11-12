import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskReport } from '@/server/services/reports'
import { DateField } from '@/ui/form/date-field'
import { Notice } from '@/ui/form/notice'
import { formatBpPercent, formatDateTime } from '@/ui/format'
import { ExportPanel } from '@/ui/insight/export-panel'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { ReportTable, type ReportColumnView, type ReportRowView } from '@/ui/insight/report-table'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { dayText } from '../../kpi/_present'
import { RISK_REPORT, SUPPLIER_REPORT_DAYS, periodFrom } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('riskReport')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-10'
const sectionTitle = 'text-base font-semibold text-ink'
const TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const
const FLAGS = ['CEASED', 'VAT_CANCELLED', 'NOT_FOUND'] as const
const ASSESSMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const
const has = <T extends string>(list: readonly T[], v: string | null): v is T => v !== null && (list as readonly string[]).includes(v)

// The supplier risk report (S11-11 · BR-RSK-15 · FR-RSK-204 AC2 · §11.4 G-9 · sub-spec S11 "/reports/risk"): for a period
// (the last 90 days unless the address says otherwise · a supplier's first PO is rare) and within the reader's
// report.view scope (riskReport checks it · a head: the suppliers their departments have a PO with), G-9 — of the
// suppliers whose first PO in the period met the gate at HIGH, the share assessed before it — with the suppliers it
// counts; then, as of now, the suppliers by tier ("never assessed" apart from LOW), the assessments pending past their
// due time, the suppliers past their cycle, the overrides and the registry flags. Each supplier and document opens on
// its own page, which checks the reader's rights again. The numbers come from the code, never from the AI; the G-9
// table exports as Excel with a checksum (report RSK_G9).
export default async function RiskReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tr, locale] = await Promise.all([getTranslations('riskReport'), getTranslations('reports'), getLocale()])
  const period = periodFrom(await searchParams, ctx.now, SUPPLIER_REPORT_DAYS)
  const result = await riskReport(ctx, { from: period.from, to: period.to })
  if (!result.ok && result.error.code === 'FORBIDDEN') return <Refused title={t('title')} message={tr('forbidden')} href="/" linkLabel={tr('home')} />
  if (!result.ok && result.error.code === 'MODULE_DISABLED') return <Refused title={t('title')} message={t('moduleOff')} href="/reports" linkLabel={t('back')} />

  const back = (
    <Link href="/reports" className={linkClass}>
      {t('back')}
    </Link>
  )
  const periodForm = (
    <Panel label={t('periodLabel')}>
      <form key={`${period.from}:${period.to}`} method="get" action="/reports/risk" className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="md:w-72">
          <DateField id="risk-from" name="from" label={tr('params.from')} defaultValue={period.from} required />
        </div>
        <div className="md:w-72">
          <DateField id="risk-to" name="to" label={tr('params.to')} defaultValue={period.to} required />
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
  const tierText = (tier: string | null) => (has(TIERS, tier) ? t(`tier.${tier}`) : t('tier.none'))
  const supplierLink = (id: string, text: string) => ({ text, href: `/risk/suppliers/${id}` })

  const g9Columns: ReportColumnView[] = [
    { key: 'supplier', header: t('g9.columns.supplier'), numeric: false },
    { key: 'po', header: t('g9.columns.po'), numeric: false },
    { key: 'submittedAt', header: t('g9.columns.submittedAt'), numeric: false },
    { key: 'passedWith', header: t('g9.columns.passedWith'), numeric: false },
  ]
  const g9Rows: ReportRowView[] = r.g9.rows.map((x) => ({
    id: x.supplierId,
    cells: {
      supplier: supplierLink(x.supplierId, `${x.supplierCode} ${x.supplierName}`),
      po: { text: x.poNumber ?? t('noNumber'), href: `/procurement/pos/${x.poId}` },
      submittedAt: { text: formatDateTime(locale, x.submittedAt) },
      passedWith: { text: t(`g9.source.${x.source}`) },
    },
  }))
  const tierColumns: ReportColumnView[] = [
    { key: 'tier', header: t('tiers.columns.tier'), numeric: false },
    { key: 'suppliers', header: t('tiers.columns.suppliers'), numeric: true },
  ]
  const tierRows: ReportRowView[] = r.tiers.map((x) => ({ id: x.tier ?? 'NONE', cells: { tier: { text: tierText(x.tier) }, suppliers: { text: String(x.suppliers) } } }))
  const pendingColumns: ReportColumnView[] = [
    { key: 'assessment', header: t('pending.columns.assessment'), numeric: false },
    { key: 'supplier', header: t('pending.columns.supplier'), numeric: false },
    { key: 'status', header: t('pending.columns.status'), numeric: false },
    { key: 'openedAt', header: t('pending.columns.openedAt'), numeric: false },
    { key: 'escalatedAt', header: t('pending.columns.escalatedAt'), numeric: false },
  ]
  const pendingRows: ReportRowView[] = r.pending.map((x) => ({
    id: x.assessmentId,
    cells: {
      assessment: { text: x.number ?? t('noNumber'), href: `/risk/assessments/${x.assessmentId}` },
      supplier: supplierLink(x.supplierId, x.supplierName),
      status: { text: has(ASSESSMENT_STATUSES, x.status) ? t(`pending.status.${x.status}`) : x.status },
      openedAt: { text: formatDateTime(locale, x.openedAt) },
      escalatedAt: { text: formatDateTime(locale, x.escalatedAt) },
    },
  }))
  const overdueColumns: ReportColumnView[] = [
    { key: 'supplier', header: t('overdue.columns.supplier'), numeric: false },
    { key: 'tier', header: t('overdue.columns.tier'), numeric: false },
    { key: 'validUntil', header: t('overdue.columns.validUntil'), numeric: false },
  ]
  const overdueRows: ReportRowView[] = r.overdue.map((x) => ({
    id: x.supplierId,
    cells: { supplier: supplierLink(x.supplierId, `${x.code} ${x.name}`), tier: { text: tierText(x.tier) }, validUntil: { text: x.validUntil ? dayText(locale, x.validUntil) : '-' } },
  }))
  const overrideColumns: ReportColumnView[] = [
    { key: 'override', header: t('overrides.columns.override'), numeric: false },
    { key: 'supplier', header: t('overrides.columns.supplier'), numeric: false },
    { key: 'status', header: t('overrides.columns.status'), numeric: false },
    { key: 'expiresOn', header: t('overrides.columns.expiresOn'), numeric: false },
    { key: 'used', header: t('overrides.columns.used'), numeric: true },
    { key: 'requestedBy', header: t('overrides.columns.requestedBy'), numeric: false },
  ]
  const overrideRows: ReportRowView[] = r.overrides.rows.map((x) => ({
    id: x.id,
    cells: {
      override: { text: x.number ?? t('noNumber'), href: `/risk/overrides/${x.id}` },
      supplier: { text: x.supplierName },
      status: { text: t(`overrides.status.${x.status}`) },
      expiresOn: { text: dayText(locale, x.expiresOn) },
      used: { text: t('overrides.usedValue', { count: x.usedCount, amount: formatSatang(x.usedGrossSatang), cap: formatSatang(x.capGrossSatang) }) },
      requestedBy: { text: x.requestedBy },
    },
  }))
  const flagColumns: ReportColumnView[] = [
    { key: 'supplier', header: t('flagged.columns.supplier'), numeric: false },
    { key: 'flag', header: t('flagged.columns.flag'), numeric: false },
    { key: 'flaggedAt', header: t('flagged.columns.flaggedAt'), numeric: false },
  ]
  const flagRows: ReportRowView[] = r.flagged.map((x) => ({
    id: x.supplierId,
    cells: {
      supplier: supplierLink(x.supplierId, `${x.code} ${x.name}`),
      flag: { text: has(FLAGS, x.registryFlag) ? t(`flagged.flag.${x.registryFlag}`) : x.registryFlag },
      flaggedAt: { text: x.flaggedAt ? formatDateTime(locale, x.flaggedAt) : '-' },
    },
  }))

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
        <Panel title={t('g9.title')} id="g9">
          <dl aria-label={t('g9.title')} className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1 rounded-md border border-line p-3">
              <dt className="text-base text-ink-muted md:text-sm">{t('g9.rate')}</dt>
              <dd className={r.g9.bp === null ? 'text-ink-muted' : 'text-xl font-semibold text-ink tabular'}>{r.g9.bp === null ? t('g9.none') : formatBpPercent(r.g9.bp, { signed: false })}</dd>
            </div>
            <div className="flex flex-col gap-1 rounded-md border border-line p-3">
              <dt className="text-base text-ink-muted md:text-sm">{t('g9.numerator')}</dt>
              <dd className="text-xl font-semibold text-ink tabular">{t('g9.ofSuppliers', { count: r.g9.numerator })}</dd>
            </div>
            <div className="flex flex-col gap-1 rounded-md border border-line p-3">
              <dt className="text-base text-ink-muted md:text-sm">{t('g9.denominator')}</dt>
              <dd className="text-xl font-semibold text-ink tabular">
                {r.g9.denominator > 0 ? (
                  <a href="#g9-suppliers" className="text-ink underline-offset-4 hover:underline">
                    {t('g9.ofSuppliers', { count: r.g9.denominator })}
                  </a>
                ) : (
                  t('g9.ofSuppliers', { count: 0 })
                )}
              </dd>
            </div>
          </dl>
          <p className="text-base text-ink-muted md:text-sm">{t('g9.hint')}</p>
        </Panel>
        <Panel title={t('g9.listTitle', { count: r.g9.rows.length })} id="g9-suppliers">
          {g9Rows.length ? <ReportTable caption={t('g9.caption')} columns={g9Columns} rows={g9Rows} rowHeader={0} lead={1} /> : <EmptyState title={t('g9.emptyTitle')} hint={t('g9.emptyHint')} />}
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className={sectionTitle}>{t('export.title')}</h3>
            <p className="text-base text-ink-muted md:text-sm">{t('export.hint')}</p>
            <ExportPanel endpoint="/reports/export" payload={{ reportCode: RISK_REPORT, params: { from: period.from, to: period.to } }} formats={['xlsx']} open={downloadUrlAction} />
          </div>
        </Panel>
        <Panel title={t('tiers.title')} id="tiers">
          <p className="text-ink-muted">{t('tiers.intro')}</p>
          <ReportTable caption={t('tiers.caption')} columns={tierColumns} rows={tierRows} rowHeader={0} lead={1} />
        </Panel>
        <Panel title={t('pending.title', { count: r.pending.length })} id="pending">
          <p className="text-ink-muted">{t('pending.intro')}</p>
          {pendingRows.length ? <ReportTable caption={t('pending.caption')} columns={pendingColumns} rows={pendingRows} rowHeader={0} lead={2} /> : <EmptyState title={t('pending.emptyTitle')} hint={t('pending.emptyHint')} />}
        </Panel>
        <Panel title={t('overdue.title', { count: r.overdue.length })} id="overdue">
          <p className="text-ink-muted">{t('overdue.intro')}</p>
          {overdueRows.length ? <ReportTable caption={t('overdue.caption')} columns={overdueColumns} rows={overdueRows} rowHeader={0} lead={1} /> : <EmptyState title={t('overdue.emptyTitle')} hint={t('overdue.emptyHint')} />}
        </Panel>
        <Panel title={t('overrides.title')} id="overrides">
          <p className="text-ink-muted">{t('overrides.summary', { open: r.overrides.open, expired: r.overrides.expired, used: r.overrides.used })}</p>
          {overrideRows.length ? <ReportTable caption={t('overrides.caption')} columns={overrideColumns} rows={overrideRows} rowHeader={0} lead={2} /> : <EmptyState title={t('overrides.emptyTitle')} hint={t('overrides.emptyHint')} />}
        </Panel>
        <Panel title={t('flagged.title', { count: r.flagged.length })} id="flagged">
          <p className="text-ink-muted">{t('flagged.intro')}</p>
          {flagRows.length ? <ReportTable caption={t('flagged.caption')} columns={flagColumns} rows={flagRows} rowHeader={0} lead={1} /> : <EmptyState title={t('flagged.emptyTitle')} hint={t('flagged.emptyHint')} />}
        </Panel>
      </PageBody>
    </Page>
  )
}
