import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import type { SavingKind, SavingTotal } from '@/server/queries/sourcing-kpi'
import { sourcingReport } from '@/server/services/reports'
import { DateField } from '@/ui/form/date-field'
import { Notice } from '@/ui/form/notice'
import { formatBpPercent, formatDateTime } from '@/ui/format'
import { ExportPanel } from '@/ui/insight/export-panel'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { ReportTable, type ReportColumnView, type ReportRowView } from '@/ui/insight/report-table'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { isRfxKind, isRfxStatus } from '@/ui/sourcing/rfx-looks'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { dayText } from '../../kpi/_present'
import { SOURCING_REPORT, quarterPeriodFrom } from '../_present'

export async function generateMetadata() {
  const t = await getTranslations('sourcingReport')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-10'
const figureLink = 'text-ink underline-offset-4 hover:underline'
const sectionTitle = 'text-base font-semibold text-ink'
const KINDS: readonly SavingKind[] = ['QUOTATION', 'ESTIMATE', 'MIXED']
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const kindOf = (v: string | undefined): SavingKind | null => ((KINDS as readonly string[]).includes(v ?? '') ? (v as SavingKind) : null)

/** "2026-Q4" → the first and last day of that quarter */
function quarterRange(quarter: string): { from: string; to: string } {
  const year = Number(quarter.slice(0, 4))
  const q = Number(quarter.slice(-1))
  const firstMonth = (q - 1) * 3 + 1
  const lastDay = new Date(Date.UTC(year, firstMonth + 2, 0)).getUTCDate()
  return { from: `${year}-${String(firstMonth).padStart(2, '0')}-01`, to: `${year}-${String(firstMonth + 2).padStart(2, '0')}-${lastDay}` }
}

// The sourcing report (S10-15 · BR-RFX-15 · §11.4 G-8 · sub-spec S10 "/reports/sourcing"): for a period of award
// approvals (this Thai quarter up to today unless the address says otherwise) and within the reader's report.view scope
// (sourcingReport checks it and the SOURCING module), the total savings with their basis points, by kind of baseline
// (QUOTATION · ESTIMATE · MIXED) and by quarter; the lower median of the business days from opening an RFx to approving
// its award; the awards it counts, and the RFx still open. Every figure leads to the rows it adds up (§9.9); an RFx and
// an award open on their own pages, which check the reader's rights again. The numbers come from
// src/server/queries/sourcing-kpi.ts, never from the AI; the awards export as Excel with a checksum (report SRC_G8).
export default async function SourcingReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tr, tl, locale] = await Promise.all([getTranslations('sourcingReport'), getTranslations('reports'), getTranslations('sourcing.list'), getLocale()])
  const params = await searchParams
  const period = quarterPeriodFrom(params, ctx.now)
  // ?kind= narrows the awards table to one kind of baseline: where a kind's figure leads (§9.9)
  const kind = kindOf(one(params.kind))
  const result = await sourcingReport(ctx, { from: period.from, to: period.to })
  if (!result.ok && result.error.code === 'FORBIDDEN') return <Refused title={t('title')} message={tr('forbidden')} href="/" linkLabel={tr('home')} />
  if (!result.ok && result.error.code === 'MODULE_DISABLED') return <Refused title={t('title')} message={t('moduleOff')} href="/reports" linkLabel={t('back')} />

  const back = (
    <Link href="/reports" className={linkClass}>
      {t('back')}
    </Link>
  )
  const periodForm = (
    <Panel label={t('periodLabel')}>
      <form key={`${period.from}:${period.to}`} method="get" action="/reports/sourcing" className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="md:w-72">
          <DateField id="sourcing-from" name="from" label={tr('params.from')} defaultValue={period.from} required />
        </div>
        <div className="md:w-72">
          <DateField id="sourcing-to" name="to" label={tr('params.to')} defaultValue={period.to} required />
        </div>
        <Button type="submit" variant="outline" className="min-h-11 shrink-0 self-start md:mt-[calc(1lh+0.375rem)] lg:min-h-10">
          {t('run')}
        </Button>
      </form>
      {period.invalid ? <Notice tone="info">{t('periodInvalid')}</Notice> : null}
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
  const savingText = (s: SavingTotal) => (s.savingsBp === null ? t('amount', { amount: formatSatang(s.savings) }) : t('amountBp', { amount: formatSatang(s.savings), percent: formatBpPercent(s.savingsBp) }))
  const quarterText = (quarter: string) => t('quarter', { q: quarter.slice(-1), year: locale === 'en' ? quarter.slice(0, 4) : String(Number(quarter.slice(0, 4)) + 543) })
  const hrefOf = (range: { from: string; to: string }, k: SavingKind | null) => `/reports/sourcing?${new URLSearchParams({ ...range, ...(k ? { kind: k } : {}) }).toString()}#awards`
  const here = { from: period.from, to: period.to }

  const figures = [
    { key: 'total', label: t('summary.total'), text: r.total.awards ? savingText(r.total) : t('noneYet'), empty: r.total.awards === 0, href: hrefOf(here, null) },
    { key: 'baseline', label: t('summary.baseline'), text: r.total.awards ? t('amount', { amount: formatSatang(r.total.baselineNet) }) : t('noneYet'), empty: r.total.awards === 0, href: hrefOf(here, null) },
    { key: 'median', label: t('summary.median'), text: r.medianDays === null ? t('noneYet') : t('days', { value: r.medianDays }), empty: r.medianDays === null, href: hrefOf(here, null) },
    ...KINDS.map((k) => ({ key: k, label: t(`kind.${k}`), text: r.total.byKind[k].awards ? savingText(r.total.byKind[k]) : t('noAward'), empty: r.total.byKind[k].awards === 0, href: hrefOf(here, k) })),
  ]

  const quarterColumns: ReportColumnView[] = [
    { key: 'quarter', header: t('quarters.columns.quarter'), numeric: false },
    { key: 'awards', header: t('quarters.columns.awards'), numeric: true },
    { key: 'baseline', header: t('quarters.columns.baseline'), numeric: true },
    { key: 'savings', header: t('quarters.columns.savings'), numeric: true },
    ...KINDS.map((k) => ({ key: k, header: t(`quarters.columns.${k}`), numeric: true })),
  ]
  // a quarter's figures lead to its awards: the same report over that quarter (§9.9)
  const quarterRows: ReportRowView[] = r.quarters.map((q) => {
    const range = quarterRange(q.quarter)
    const href = hrefOf(range, null)
    return {
      id: q.quarter,
      cells: {
        quarter: { text: quarterText(q.quarter), href },
        awards: { text: String(q.awards), href },
        baseline: { text: formatSatang(q.baselineNet), href },
        savings: { text: savingText(q), href },
        ...Object.fromEntries(KINDS.map((k) => [k, q.byKind[k].awards ? { text: savingText(q.byKind[k]), href: hrefOf(range, k) } : { text: '', emptyLabel: t('noAward') }])),
      },
    }
  })

  const awardColumns: ReportColumnView[] = [
    { key: 'rfx', header: t('awards.columns.rfx'), numeric: false },
    { key: 'award', header: t('awards.columns.award'), numeric: false },
    { key: 'winners', header: t('awards.columns.winners'), numeric: false },
    { key: 'decidedAt', header: t('awards.columns.decidedAt'), numeric: false },
    { key: 'kind', header: t('awards.columns.kind'), numeric: false },
    { key: 'baseline', header: t('awards.columns.baseline'), numeric: true },
    { key: 'awarded', header: t('awards.columns.awarded'), numeric: true },
    { key: 'savings', header: t('awards.columns.savings'), numeric: true },
    { key: 'days', header: t('awards.columns.days'), numeric: true },
  ]
  const shown = kind ? r.awards.filter((a) => a.baselineKind === kind) : r.awards
  const awardRows: ReportRowView[] = shown.map((a) => ({
      id: a.awardId,
      cells: {
        rfx: { text: `${a.rfxNumber ?? t('noNumber')} · ${a.rfxTitle}`, href: `/sourcing/${a.rfxEventId}` },
        award: { text: a.awardNumber ?? t('noNumber'), href: `/sourcing/${a.rfxEventId}/award` },
        winners: { text: a.winners.join(', ') },
        decidedAt: { text: formatDateTime(locale, a.decidedAt) },
        kind: { text: a.baselineKind ? t(`kind.${a.baselineKind}`) : t('notComputable') },
        baseline: a.baselineNet === null ? { text: '', emptyLabel: t('notComputable') } : { text: formatSatang(a.baselineNet) },
        awarded: { text: formatSatang(a.awardedNet) },
        savings: a.savings === null ? { text: '', emptyLabel: t('notComputable') } : { text: a.savingsBp === null ? formatSatang(a.savings) : `${formatSatang(a.savings)} (${formatBpPercent(a.savingsBp)})` },
        days: { text: a.businessDays },
      },
  }))

  const openColumns: ReportColumnView[] = [
    { key: 'rfx', header: t('open.columns.rfx'), numeric: false },
    { key: 'kind', header: t('open.columns.kind'), numeric: false },
    { key: 'status', header: t('open.columns.status'), numeric: false },
    { key: 'closesAt', header: t('open.columns.closesAt'), numeric: false },
    { key: 'submitted', header: t('open.columns.bids'), numeric: true },
  ]
  const openRows: ReportRowView[] = r.open.map((o) => ({
    id: o.rfxEventId,
    cells: {
      rfx: { text: `${o.number ?? t('noNumber')} · ${o.title}`, href: `/sourcing/${o.rfxEventId}` },
      kind: { text: isRfxKind(o.kind) ? tl(`kind.${o.kind}`) : o.kind },
      status: { text: isRfxStatus(o.status) ? tl(`status.${o.status}`) : o.status },
      closesAt: { text: o.closesAt ? formatDateTime(locale, o.closesAt) : t('open.noClose') },
      submitted: { text: t('open.bids', { bids: o.bids, invited: o.invited }), href: `/sourcing/${o.rfxEventId}` },
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
        <Panel title={t('summary.title')} id="g8">
          <dl aria-label={t('summary.title')} className="grid gap-3 md:grid-cols-3">
            {figures.map((f) => (
              <div key={f.key} className="flex flex-col gap-1 rounded-md border border-line p-3">
                <dt className="text-base text-ink-muted md:text-sm">{f.label}</dt>
                {/* each figure leads to the awards it adds up, in the table below (§9.9) */}
                <dd className={f.empty ? 'text-ink-muted' : 'text-xl font-semibold text-ink tabular'}>
                  {f.empty ? (
                    f.text
                  ) : (
                    <a href={f.href} className={figureLink}>
                      {f.text}
                    </a>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-base text-ink-muted md:text-sm">{t('summary.hint')}</p>
          {r.withoutBaseline ? <Notice tone="info">{t('summary.withoutBaseline', { count: r.withoutBaseline })}</Notice> : null}
        </Panel>
        <Panel title={t('quarters.title')} id="quarters">
          {quarterRows.length ? <ReportTable caption={t('quarters.caption')} columns={quarterColumns} rows={quarterRows} rowHeader={0} lead={1} /> : <EmptyState title={t('awards.emptyTitle')} hint={t('awards.emptyHint')} />}
        </Panel>
        <Panel title={t('awards.title', { count: shown.length })} id="awards">
          {kind ? (
            <p className="text-ink-muted">
              {t('awards.only', { kind: t(`kind.${kind}`) })}{' '}
              <Link href={hrefOf(here, null)} className="font-medium text-primary underline underline-offset-4 hover:no-underline">
                {t('awards.showAll')}
              </Link>
            </p>
          ) : null}
          {shown.length ? (
            <ReportTable caption={kind ? `${t('awards.caption')} · ${t(`kind.${kind}`)}` : t('awards.caption')} columns={awardColumns} rows={awardRows} rowHeader={0} lead={2} />
          ) : (
            <EmptyState title={t('awards.emptyTitle')} hint={t('awards.emptyHint')} />
          )}
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className={sectionTitle}>{t('export.title')}</h3>
            <p className="text-base text-ink-muted md:text-sm">{t('export.hint')}</p>
            <ExportPanel endpoint="/reports/export" payload={{ reportCode: SOURCING_REPORT, params: { from: period.from, to: period.to } }} formats={['xlsx']} open={downloadUrlAction} />
          </div>
        </Panel>
        <Panel title={t('open.title', { count: r.open.length })} id="open">
          <p className="text-ink-muted">{t('open.intro')}</p>
          {openRows.length ? <ReportTable caption={t('open.caption')} columns={openColumns} rows={openRows} rowHeader={0} lead={2} /> : <EmptyState title={t('open.emptyTitle')} hint={t('open.emptyHint')} />}
        </Panel>
      </PageBody>
    </Page>
  )
}
