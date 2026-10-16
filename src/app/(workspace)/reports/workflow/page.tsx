import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listDepartments, listPositions } from '@/server/queries/org'
import { workflowReport } from '@/server/services/reports'
import { DocTabs } from '@/ui/document/doc-tabs'
import { DateField } from '@/ui/form/date-field'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { AddressParamField } from '@/ui/insight/address-param-field'
import { ExportPanel } from '@/ui/insight/export-panel'
import { HeatChart } from '@/ui/insight/heat-chart'
import { InsightChart } from '@/ui/insight/insight-chart'
import { EmptyState, Refused } from '@/ui/insight/refused'
import { ReportTable } from '@/ui/insight/report-table'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { linkRights } from '../../board/_rights'
import { dayText } from '../../kpi/_present'
import { DEFAULT_REPORT_DAYS, periodFrom } from '../_present'
import { TAB_REPORTS, WORKFLOW_TABS, bottlenecksView, cycleView, decisionsHeat, openHeat, tabFrom, wrongDoaView, type WorkflowTab } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('workflowReports')
  return { title: t('title') }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline lg:min-h-10'
const sectionTitle = 'text-base font-semibold text-ink'

// The workflow reports (S6-20 · FR-VIS-101 AC1–AC3 · BR-RPT-03 to BR-RPT-06): for a period (the last 30 days unless the
// address says otherwise) and within the reader's report.view scope (workflowReport checks it), four tabs — cycle time
// with the requests it counts, the bottlenecks by position and by person, the decisions outside the DOA with the
// documents they concern, and the heatmaps of decisions by weekday and hour and of open tasks by department and age.
// Every chart loads lazily and has a table view (AC3); every tab exports its report as Excel with a checksum
// (exportReport, the report codes WF_*). The documents open on their own pages, which check the reader's rights again.
export default async function WorkflowReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSession()
  const ctx = ctxFromSession(state, 'WEB', systemClock.now())
  if (!ctx || state.kind !== 'member') return null
  const [t, tr, locale] = await Promise.all([getTranslations('workflowReports'), getTranslations('reports'), getLocale()])
  const params = await searchParams
  const period = periodFrom(params, ctx.now, DEFAULT_REPORT_DAYS)
  const tab = tabFrom(one(params.tab))
  const result = await workflowReport(ctx, { from: period.from, to: period.to })
  if (!result.ok && result.error.code === 'FORBIDDEN') return <Refused title={t('title')} message={tr('forbidden')} href="/" linkLabel={tr('home')} />

  const back = (
    <Link href="/reports" className={linkClass}>
      {t('back')}
    </Link>
  )
  const periodForm = (
    <Panel label={t('periodLabel')}>
      {/* the same period filter as /reports: days picked in Buddhist-era years and read back in words (DateField) */}
      <form key={`${period.from}:${period.to}`} method="get" action="/reports/workflow" className="flex flex-col gap-3 md:flex-row md:items-start">
        <AddressParamField name="tab" initial={tab} />
        <div className="md:w-72">
          <DateField id="workflow-from" name="from" label={tr('params.from')} defaultValue={period.from} required />
        </div>
        <div className="md:w-72">
          <DateField id="workflow-to" name="to" label={tr('params.to')} defaultValue={period.to} required />
        </div>
        <Button type="submit" variant="outline" className="min-h-11 shrink-0 self-start md:mt-[calc(1lh+0.375rem)] lg:min-h-10">
          {t('run')}
        </Button>
      </form>
      {period.invalid ? <Notice tone="info">{tr('periodInvalid', { days: DEFAULT_REPORT_DAYS })}</Notice> : null}
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
  const [positions, departments] = await Promise.all([listPositions(ctx), listDepartments(ctx)])
  const chartTexts = { showTable: t('showTable'), showChart: t('showChart') }
  const cycle = cycleView(t, locale, r.cycle)
  const bottlenecks = bottlenecksView(t, locale, r.bottlenecks, positions, departments)
  const wrongDoa = wrongDoaView(t, locale, r.wrongDoa, linkRights(state.member.id, state.roles))
  const decisions = decisionsHeat(t, r.heatmap.decisions)
  const open = openHeat(t, locale, r.heatmap.openByDepartment, departments)

  const exportBlock = (key: WorkflowTab) => (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className={sectionTitle}>{t('export.title')}</h3>
      <p className="text-base text-ink-muted md:text-sm">{t(`export.${key}`)}</p>
      <ExportPanel endpoint="/reports/export" payload={{ reportCode: TAB_REPORTS[key], params: { from: period.from, to: period.to } }} formats={['xlsx']} open={downloadUrlAction} />
    </div>
  )
  const empty = (title: string, hint: string) => <EmptyState title={title} hint={hint} />

  const content: Record<WorkflowTab, ReactNode> = {
    cycle: (
      <div className="flex flex-col gap-5">
        <dl aria-label={t('cycle.mediansLabel')} className="grid gap-3 md:grid-cols-3">
          {cycle.medians.map((m) => (
            <div key={m.key} className="flex flex-col gap-1 rounded-md border border-line p-3">
              <dt className="text-base text-ink-muted md:text-sm">{m.label}</dt>
              <dd className={m.empty ? 'text-ink-muted' : 'text-xl font-semibold text-ink tabular'}>{m.value}</dd>
            </div>
          ))}
        </dl>
        {cycle.chart ? <InsightChart caption={cycle.chart.caption} unit={t('unitHours')} spec={cycle.chart.spec} table={cycle.chart.table} texts={chartTexts} /> : null}
        {cycle.rows.length ? (
          <section className="flex flex-col gap-2">
            <h3 className={sectionTitle}>{cycle.title}</h3>
            <ReportTable caption={t('cycle.caption')} columns={cycle.columns} rows={cycle.rows} rowHeader={0} lead={1} />
          </section>
        ) : (
          empty(t('cycle.emptyTitle'), t('cycle.emptyHint'))
        )}
        {exportBlock('cycle')}
      </div>
    ),
    bottlenecks: (
      <div className="flex flex-col gap-5">
        <p className="text-ink-muted">{t('bottlenecks.intro')}</p>
        {bottlenecks.positionRows.length ? (
          <>
            {bottlenecks.chart ? <InsightChart caption={bottlenecks.chart.caption} unit={t('unitHours')} spec={bottlenecks.chart.spec} table={bottlenecks.chart.table} texts={chartTexts} /> : null}
            <section className="flex flex-col gap-2">
              <h3 className={sectionTitle}>{t('bottlenecks.byPosition')}</h3>
              <ReportTable caption={t('bottlenecks.captionPosition')} columns={bottlenecks.positionColumns} rows={bottlenecks.positionRows} rowHeader={0} lead={1} />
            </section>
            <section className="flex flex-col gap-2">
              <h3 className={sectionTitle}>{t('bottlenecks.byPerson')}</h3>
              <ReportTable caption={t('bottlenecks.captionPerson')} columns={bottlenecks.personColumns} rows={bottlenecks.personRows} rowHeader={0} lead={1} />
            </section>
          </>
        ) : (
          empty(t('bottlenecks.emptyTitle'), t('bottlenecks.emptyHint'))
        )}
        {exportBlock('bottlenecks')}
      </div>
    ),
    wrongDoa: (
      <div className="flex flex-col gap-5">
        <p className="text-ink-muted">{t('wrongDoa.intro')}</p>
        {wrongDoa.rows.length ? (
          <>
            <p className="font-medium text-ink">{wrongDoa.summary}</p>
            <ReportTable caption={t('wrongDoa.caption')} columns={wrongDoa.columns} rows={wrongDoa.rows} rowHeader={0} lead={1} />
          </>
        ) : (
          empty(t('wrongDoa.emptyTitle'), t('wrongDoa.emptyHint'))
        )}
        {exportBlock('wrongDoa')}
      </div>
    ),
    heatmap: (
      <div className="flex flex-col gap-6">
        {decisions ? (
          <HeatChart caption={t('heatmap.decisionsCaption')} unit={t('heatmap.decisionsUnit')} spec={decisions.spec} legend={decisions.legend} legendLabel={t('heatmap.legendLabel')} table={decisions.table} texts={chartTexts} />
        ) : (
          empty(t('heatmap.noDecisionsTitle'), t('heatmap.noDecisionsHint'))
        )}
        {open ? (
          <HeatChart caption={t('heatmap.openCaption')} unit={t('heatmap.openUnit')} spec={open.spec} legend={open.legend} legendLabel={t('heatmap.legendLabel')} table={open.table} texts={chartTexts} />
        ) : (
          empty(t('heatmap.noOpenTitle'), t('heatmap.noOpenHint'))
        )}
        {exportBlock('heatmap')}
      </div>
    ),
  }

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
        <Panel label={t('tabsLabel')}>
          <DocTabs tabs={WORKFLOW_TABS.map((key) => ({ value: key, label: t(`tabs.${key}`), content: content[key] }))} initial={tab} label={t('tabsLabel')} param="tab" />
        </Panel>
      </PageBody>
    </Page>
  )
}
