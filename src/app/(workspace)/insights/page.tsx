import Link from 'next/link'
import type { ReactNode } from 'react'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { insightsView, type InsightsDto } from '@/server/services/reports/insights'
import { Notice } from '@/ui/form/notice'
import { formatDateTime } from '@/ui/format'
import { daysInPeriod } from '@/ui/insight/format'
import { InsightChart, type InsightTableView } from '@/ui/insight/insight-chart'
import type { InsightChartSpec } from '@/ui/insight/insight-charts'
import { InsightsFilters } from '@/ui/insight/insights-filters'
import { Refused } from '@/ui/insight/refused'
import { StateLine } from '@/ui/request-view/status'
import { showMoney } from '@/ui/request-form/money'
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/shadcn/card'
import { getSession } from '../../_lib/session'
import { bpText, channelText, dayText, hoursText, listHref, nameIn, percentText, type InsightsT } from './_present'

export async function generateMetadata() {
  const t = await getTranslations('insights')
  return { title: t('title') }
}

// The executive summary (spec §9.10, §11.5, FR-VIS-007): the filters in one row, then four cards — spending, budget,
// speed, control — each with its main figure, one chart with a table view, and what needs attention. Every number opens
// the documents behind it with the same filters (/insights/[list]). insightsView checks report.view and leaves out the
// cards the reader may not open (AC4): spending without po.view over the organization, budget without budget.view.

const MINUTES_PER_HOUR = 60
const TENTHS = 10

const linkClass = 'text-primary underline underline-offset-4 hover:no-underline'
const figureClass = 'flex flex-col gap-0.5 self-start rounded-sm text-ink hover:text-primary'

function Figure({ label, main, sub, href }: { label: string; main: string; sub: string; href: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-base text-ink-muted md:text-sm">{label}</p>
      <Link href={href} className={figureClass}>
        <span className="text-3xl font-semibold tabular underline-offset-4 hover:underline">{main}</span>
        <span className="text-base md:text-sm">{sub}</span>
      </Link>
    </div>
  )
}

function Attention({ t, items }: { t: InsightsT; items: ReadonlyArray<{ text: string; href: string; count: number }> }) {
  const open = items.filter((i) => i.count > 0)
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3">
      <h3 className="font-medium">{t('attention')}</h3>
      {open.length === 0 ? (
        <StateLine kind="done" className="text-base md:text-sm">
          {t('attentionNone')}
        </StateLine>
      ) : null}
      <ul className="flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={i.href}>
            <StateLine kind={i.count > 0 ? 'overdue' : 'done'} className="text-base md:text-sm">
              <Link href={i.href} className={linkClass}>
                {i.text}
              </Link>
            </StateLine>
          </li>
        ))}
      </ul>
    </section>
  )
}

function InsightCard({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <Card aria-labelledby={id} className="min-w-0 gap-4 bg-bg">
      <CardHeader>
        <CardTitle>
          <h2 id={id} className="text-xl font-semibold">
            {title}
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  )
}

export default async function InsightsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('insights'), getLocale()])
  const result = await insightsView(ctx, await searchParams)
  if (!result.ok) return <Refused title={t('title')} message={t('forbidden')} href="/" linkLabel={t('home')} />
  const d = result.data
  const f = d.filters
  const chartTexts = { showTable: t('chart.showTable'), showChart: t('chart.showChart') }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-4xl flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-ink-muted">{t('intro')}</p>
        <p className="font-medium text-ink">{t('periodLine', { from: dayText(locale, f.from), to: dayText(locale, f.to), days: daysInPeriod(f.from, f.to) })}</p>
        <p className="text-base text-ink-muted md:text-sm">
          {d.scope === 'DEPT' ? `${t('scopeDept')} · ` : ''}
          {t('asOf', { time: formatDateTime(locale, d.asOf) })}
        </p>
      </div>

      <InsightsFilters
        values={{ range: f.range, from: f.from, to: f.to, departmentId: f.departmentId, requestTypeId: f.requestTypeId }}
        departments={d.options.departments.map((x) => ({ id: x.id, label: nameIn(locale, x) }))}
        types={d.options.requestTypes.map((x) => ({ id: x.id, label: nameIn(locale, x) }))}
        texts={{
          label: t('filters.label'),
          period: t('filters.period'),
          ranges: { '30d': t('filters.ranges.30d'), '90d': t('filters.ranges.90d'), fy: t('filters.ranges.fy'), custom: t('filters.ranges.custom') },
          department: t('filters.department'),
          allDepartments: t('filters.allDepartments'),
          type: t('filters.type'),
          allTypes: t('filters.allTypes'),
          clear: t('filters.clear'),
          from: t('filters.from'),
          to: t('filters.to'),
          show: t('filters.show'),
        }}
      />
      {d.periodInvalid ? <Notice tone="info">{t('notices.periodInvalid')}</Notice> : null}
      {d.ignored.map((which) => (
        <Notice key={which} tone="info">
          {which === 'department' ? t('notices.department') : t('notices.type')}
        </Notice>
      ))}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {d.spend ? <SpendCard t={t} locale={locale} d={d} spend={d.spend} chartTexts={chartTexts} /> : null}
        {d.budget ? <BudgetCard t={t} locale={locale} d={d} budget={d.budget} chartTexts={chartTexts} /> : null}
        <SpeedCard t={t} locale={locale} d={d} chartTexts={chartTexts} />
        <ControlCard t={t} d={d} chartTexts={chartTexts} />
      </div>
    </div>
  )
}

type ChartTexts = { showTable: string; showChart: string }

function SpendCard({ t, locale, d, spend, chartTexts }: { t: InsightsT; locale: string; d: InsightsDto; spend: NonNullable<InsightsDto['spend']>; chartTexts: ChartTexts }) {
  const f = d.filters
  const spec: InsightChartSpec = {
    kind: 'bars',
    series: t('spend.series'),
    rows: spend.chart.map((b) => ({ label: b.department ? nameIn(locale, b.department) : t('spend.others'), value: b.barBp, text: showMoney(b.net) })),
  }
  const table: InsightTableView = {
    columns: [t('spend.department'), t('spend.amount')],
    rows: spend.byDepartment.map((x) => [{ text: nameIn(locale, x) }, { text: showMoney(x.net), href: listHref('spend', f, { dept: x.id }) }]),
  }
  return (
    <InsightCard id="insights-spend" title={t('spend.title')}>
      <Figure label={t('spend.label')} main={t('spend.main', { amount: showMoney(spend.total) })} sub={spend.poCount ? t('spend.count', { count: spend.poCount }) : t('spend.empty')} href={listHref('spend', f)} />
      {spend.byDepartment.length ? <InsightChart caption={t('spend.chartTitle')} unit={t('spend.unit')} spec={spec} table={table} texts={chartTexts} /> : null}
      <Attention t={t} items={[{ text: t('spend.priceAlerts', { pct: spend.alertPct, count: spend.priceAlerts }), href: listHref('price-alerts', f), count: spend.priceAlerts }]} />
    </InsightCard>
  )
}

function BudgetCard({ t, locale, d, budget, chartTexts }: { t: InsightsT; locale: string; d: InsightsDto; budget: NonNullable<InsightsDto['budget']>; chartTexts: ChartTexts }) {
  const f = d.filters
  const series = [
    { key: 'reserved', label: t('budget.reserved'), color: 'var(--budget-reserved)' },
    { key: 'committed', label: t('budget.committed'), color: 'var(--budget-committed)' },
    { key: 'actual', label: t('budget.actual'), color: 'var(--budget-actual)' },
  ]
  const spec: InsightChartSpec = {
    kind: 'stacked',
    series,
    max: budget.chartMaxBp,
    rows: budget.byDepartment.map((x) => ({
      label: nameIn(locale, x),
      values: { reserved: x.reservedBp, committed: x.committedBp, actual: x.actualBp },
      texts: { reserved: `${bpText(x.reservedBp)}%`, committed: `${bpText(x.committedBp)}%`, actual: `${bpText(x.actualBp)}%` },
    })),
  }
  const table: InsightTableView = {
    columns: [t('budget.department'), t('budget.reserved'), t('budget.committed'), t('budget.actual'), t('budget.used')],
    rows: budget.byDepartment.map((x) => {
      const href = listHref('budget', f, { dept: x.id })
      return [{ text: nameIn(locale, x) }, { text: `${bpText(x.reservedBp)}%`, href }, { text: `${bpText(x.committedBp)}%`, href }, { text: `${bpText(x.actualBp)}%`, href }, { text: `${bpText(x.usedBp ?? 0)}%`, href }]
    }),
  }
  return (
    <InsightCard id="insights-budget" title={t('budget.title')}>
      <Figure label={t('budget.label')} main={t('budget.main', { pct: bpText(budget.total.usedBp ?? 0) })} sub={t('budget.of', { planned: showMoney(budget.total.planned), code: budget.fiscalYearCode, date: dayText(locale, budget.asOf) })} href={listHref('budget', f)} />
      {budget.typeIgnored ? <p className="text-base text-ink-muted md:text-sm">{t('budget.typeIgnored')}</p> : null}
      {budget.byDepartment.length ? <InsightChart caption={t('budget.chartTitle')} unit={t('budget.unit')} spec={spec} table={table} texts={chartTexts} /> : null}
      <Attention t={t} items={[{ text: t('budget.low', { pct: budget.lowPct, count: budget.lowLines }), href: listHref('budget-low', f), count: budget.lowLines }]} />
    </InsightCard>
  )
}

/** Business minutes as hours with one decimal, a number for drawing only */
const hoursValue = (minutes: number) => Math.round((minutes * TENTHS) / MINUTES_PER_HOUR) / TENTHS

function SpeedCard({ t, locale, d, chartTexts }: { t: InsightsT; locale: string; d: InsightsDto; chartTexts: ChartTexts }) {
  const f = d.filters
  const s = d.speed
  const weekLabel = (start: string) => dayText(locale, start)
  const spec: InsightChartSpec = { kind: 'line', series: t('speed.series'), unit: t('speed.axis'), rows: s.weekly.map((w) => ({ label: weekLabel(w.start), value: w.medianMinutes === null ? null : hoursValue(w.medianMinutes) })) }
  const table: InsightTableView = {
    columns: [t('speed.week'), t('speed.median'), t('speed.steps')],
    rows: s.weekly.map((w) => {
      const href = w.count ? listHref('decision-time', f, { week: w.start }) : null
      return [{ text: weekLabel(w.start) }, { text: w.medianMinutes === null ? t('speed.noSteps') : hoursText(w.medianMinutes), href }, { text: String(w.count), href }]
    }),
  }
  const attention = [{ text: t('speed.overdue', { count: s.overdue }), href: listHref('overdue', f), count: s.overdue }]
  if (s.idlePos !== null) attention.push({ text: t('speed.idle', { days: s.idleDays, count: s.idlePos }), href: listHref('idle-pos', f), count: s.idlePos })
  return (
    <InsightCard id="insights-speed" title={t('speed.title')}>
      <Figure
        label={t('speed.label')}
        main={s.submitToPoMedianMinutes === null ? '–' : t('speed.main', { hours: hoursText(s.submitToPoMedianMinutes) })}
        sub={s.submitToPoCount ? t('speed.count', { count: s.submitToPoCount }) : t('speed.none')}
        href={listHref('submit-to-po', f)}
      />
      <Link href={listHref('decision-time', f)} className={`text-base md:text-sm ${linkClass}`}>
        {s.decisionMedianMinutes === null ? t('speed.decisionNone') : t('speed.decision', { hours: hoursText(s.decisionMedianMinutes), count: s.decisionCount })}
      </Link>
      <InsightChart caption={t('speed.chartTitle')} unit={t('speed.unit')} spec={spec} table={table} texts={chartTexts} />
      <Attention t={t} items={attention} />
    </InsightCard>
  )
}

function ControlCard({ t, d, chartTexts }: { t: InsightsT; d: InsightsDto; chartTexts: ChartTexts }) {
  const f = d.filters
  const c = d.control
  const shown = c.channels.filter((x) => x.count > 0)
  const spec: InsightChartSpec = { kind: 'share', label: t('control.chartLabel'), series: shown.map((x) => ({ key: x.channel, label: channelText(t, x.channel), value: x.count, text: `${percentText(x.count, c.decisions)}% (${x.count})` })) }
  const table: InsightTableView = {
    columns: [t('control.channel'), t('control.decisions'), '%'],
    rows: c.channels.map((x) => {
      const href = x.count ? listHref('channel', f, { channel: x.channel }) : null
      return [{ text: channelText(t, x.channel) }, { text: String(x.count), href }, { text: `${percentText(x.count, c.decisions) ?? '0.0'}%`, href }]
    }),
  }
  return (
    <InsightCard id="insights-control" title={t('control.title')}>
      <Figure
        label={t('control.label')}
        main={c.decisions ? t('control.main', { pct: percentText(c.withDoa, c.decisions)! }) : '–'}
        sub={c.decisions ? t('control.count', { withDoa: c.withDoa, total: c.decisions }) : t('control.none')}
        href={listHref('doa-ref', f)}
      />
      <StateLine kind={c.overBudget > 0 ? 'overdue' : 'done'} className="text-base md:text-sm">
        <Link href={listHref('over-budget', f)} className={linkClass}>
          {t('control.overBudget', { count: c.overBudget })}
        </Link>
      </StateLine>
      {c.decisions ? <InsightChart caption={t('control.chartTitle')} unit={t('control.unit')} spec={spec} table={table} texts={chartTexts} /> : null}
      <Attention
        t={t}
        items={[
          { text: t('control.missing', { count: c.withoutDoa }), href: listHref('doa-missing', f), count: c.withoutDoa },
          { text: t('control.suppliers', { count: c.supplierChanges }), href: listHref('supplier-changes', f), count: c.supplierChanges },
        ]}
      />
      {d.scope === 'ORG' ? (
        <Link href={`/kpi?from=${f.from}&to=${f.to}`} className={`inline-flex min-h-11 items-center self-start font-medium ${linkClass}`}>
          {t('control.kpi')}
        </Link>
      ) : null}
    </InsightCard>
  )
}
