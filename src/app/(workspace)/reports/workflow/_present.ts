import { getTranslations } from 'next-intl/server'
import type { DepartmentRow, PositionRow } from '@/server/queries/org'
import type { AgeBand, WorkflowReport } from '@/server/services/reports/workflow'
import { formatDateTime } from '@/ui/format'
import { hoursText } from '@/ui/insight/format'
import type { HeatLegendItem, HeatLevel, HeatSpec } from '@/ui/insight/heat-chart'
import type { InsightTableView } from '@/ui/insight/insight-chart'
import type { BarsSpec } from '@/ui/insight/insight-charts'
import { documentHref, type LinkRights } from '@/ui/insight/links'
import type { ReportColumnView, ReportRowView } from '@/ui/insight/report-table'

// The workflow reports' figures in words (S6-20 · FR-VIS-101 AC1 AC3 · BR-RPT-03 to BR-RPT-06): the tab from the
// address and the report each tab exports; times in business hours with one decimal as on the KPI page; the requests
// and documents with the pages they open (the page behind checks request.view, po.view …); positions and departments by
// name; and every chart with the same figures as a table — the cycle-time and bottleneck bars, and the two heatmaps
// whose cells are levels of one colour scaled to the largest count.

// The translator's type comes from a call: an instantiation expression over the namespace costs the checker far more
const _workflowTranslator = () => getTranslations('workflowReports')
export type WorkflowT = Awaited<ReturnType<typeof _workflowTranslator>>

export const WORKFLOW_TABS = ['cycle', 'bottlenecks', 'wrongDoa', 'heatmap'] as const
export type WorkflowTab = (typeof WORKFLOW_TABS)[number]

/** The report of the catalogue each tab exports (exportReport with its code) */
export const TAB_REPORTS: Readonly<Record<WorkflowTab, string>> = { cycle: 'WF_CYCLE', bottlenecks: 'WF_BOTTLENECKS', wrongDoa: 'WF_WRONG_DOA', heatmap: 'WF_HEATMAP' }

/** The tab of a workflow report code, or null for any other report */
export const tabOfReport = (code: string): WorkflowTab | null => WORKFLOW_TABS.find((tab) => TAB_REPORTS[tab] === code) ?? null

/** The tab the address asks for, or the first */
export const tabFrom = (value: string | undefined): WorkflowTab => WORKFLOW_TABS.find((tab) => tab === value) ?? 'cycle'

/** A chart draws this many rows at most; the table under it has them all */
export const CHART_ROWS = 10

const hoursOf = (t: WorkflowT, minutes: number | null) => (minutes === null ? '' : t('hoursShort', { value: hoursText(minutes) }))

// ---------- cycle time (BR-RPT-03) ----------

export interface CycleView {
  readonly medians: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string; readonly empty: boolean }>
  readonly chart: { readonly caption: string; readonly spec: BarsSpec; readonly table: InsightTableView } | null
  readonly title: string
  readonly columns: readonly ReportColumnView[]
  readonly rows: readonly ReportRowView[]
}

export function cycleView(t: WorkflowT, locale: string, cycle: WorkflowReport['cycle']): CycleView {
  const median = (key: string, label: string, minutes: number | null) => ({ key, label, value: minutes === null ? t('noneYet') : t('hours', { value: hoursText(minutes) }), empty: minutes === null })
  const numberOf = (n: string | null) => n ?? t('cycle.noNumber')
  const longest = cycle.requests
    .flatMap((r) => (r.cycleMinutes === null ? [] : [{ ...r, cycleMinutes: r.cycleMinutes }]))
    .sort((a, b) => b.cycleMinutes - a.cycleMinutes || numberOf(a.number).localeCompare(numberOf(b.number)))
    .slice(0, CHART_ROWS)
  return {
    medians: [
      median('cycle', t('cycle.medianCycle'), cycle.medianCycleMinutes),
      median('toFirstPo', t('cycle.medianToPo'), cycle.medianToFirstPoMinutes),
      median('decision', t('cycle.medianDecision'), cycle.medianDecisionMinutes),
    ],
    chart: longest.length
      ? {
          caption: t('cycle.chartCaption', { count: longest.length }),
          spec: { kind: 'bars', series: t('cycle.series'), rows: longest.map((r) => ({ label: numberOf(r.number), value: r.cycleMinutes, text: hoursOf(t, r.cycleMinutes) })) },
          table: {
            columns: [t('cycle.columns.request'), t('cycle.columns.cycle')],
            rows: longest.map((r) => [{ text: numberOf(r.number) }, { text: hoursOf(t, r.cycleMinutes), href: `/requests/${r.requestId}` }]),
          },
        }
      : null,
    title: t('cycle.tableTitle', { count: cycle.requests.length }),
    columns: [
      { key: 'request', header: t('cycle.columns.request'), numeric: false },
      { key: 'submittedAt', header: t('cycle.columns.submittedAt'), numeric: false },
      { key: 'approvedAt', header: t('cycle.columns.approvedAt'), numeric: false },
      { key: 'cycle', header: t('cycle.columns.cycle'), numeric: true },
      { key: 'toFirstPo', header: t('cycle.columns.toFirstPo'), numeric: true },
    ],
    // the request page checks request.view itself (its scope), so every request opens — and says so when it may not
    rows: cycle.requests.map((r) => ({
      id: r.requestId,
      cells: {
        request: { text: numberOf(r.number), href: `/requests/${r.requestId}` },
        submittedAt: { text: formatDateTime(locale, r.submittedAt) },
        approvedAt: { text: r.approvedAt ? formatDateTime(locale, r.approvedAt) : '', emptyLabel: t('cycle.notApproved') },
        cycle: { text: hoursOf(t, r.cycleMinutes), emptyLabel: t('cycle.notApproved') },
        toFirstPo: { text: hoursOf(t, r.toFirstPoMinutes), emptyLabel: t('cycle.noPo') },
      },
    })),
  }
}

// ---------- bottlenecks (BR-RPT-04) ----------

/** "CEO@HQ", "MEMBER:<id>" or "CONTRACT_SIGNATORY:<id>" (resolvedFrom without its "POSITION:") in words */
export function positionText(t: WorkflowT, locale: string, at: string, positions: readonly PositionRow[], departments: readonly DepartmentRow[]): string {
  if (at.startsWith('MEMBER:')) return t('bottlenecks.named')
  if (at.startsWith('CONTRACT_SIGNATORY:')) return t('bottlenecks.signatory')
  const match = /^([^@:]+)@(.+)$/.exec(at)
  if (!match) return at
  const p = positions.find((x) => x.code === match[1])
  const d = departments.find((x) => x.code === match[2])
  const name = (row: { nameTh: string; nameEn: string | null } | undefined, code: string) => (!row ? code : locale === 'en' && row.nameEn ? row.nameEn : row.nameTh)
  return t('bottlenecks.position', { position: name(p, match[1]!), department: name(d, match[2]!) })
}

export interface BottlenecksView {
  readonly chart: { readonly caption: string; readonly spec: BarsSpec; readonly table: InsightTableView } | null
  readonly positionColumns: readonly ReportColumnView[]
  readonly positionRows: readonly ReportRowView[]
  readonly personColumns: readonly ReportColumnView[]
  readonly personRows: readonly ReportRowView[]
}

export function bottlenecksView(t: WorkflowT, locale: string, b: WorkflowReport['bottlenecks'], positions: readonly PositionRow[], departments: readonly DepartmentRow[]): BottlenecksView {
  const figures = (x: { overdue: number; median: number | null; taskIds: readonly string[] }) => ({
    overdue: { text: String(x.overdue) },
    median: { text: hoursOf(t, x.median), emptyLabel: t('bottlenecks.notDecided') },
    tasks: { text: String(x.taskIds.length) },
  })
  const figureColumns = (first: ReportColumnView): ReportColumnView[] => [
    first,
    { key: 'overdue', header: t('bottlenecks.columns.overdue'), numeric: true },
    { key: 'median', header: t('bottlenecks.columns.median'), numeric: true },
    { key: 'tasks', header: t('bottlenecks.columns.tasks'), numeric: true },
  ]
  const named = b.byPosition.map((x) => ({ ...x, text: positionText(t, locale, x.at, positions, departments) }))
  // in bottleneck order, as the table: the bars are the median time of each of the first positions that has one
  const drawn = named.flatMap((x) => (x.median === null ? [] : [{ ...x, median: x.median }])).slice(0, CHART_ROWS)
  return {
    chart: drawn.length
      ? {
          caption: t('bottlenecks.chartCaption', { count: drawn.length }),
          spec: { kind: 'bars', series: t('bottlenecks.series'), rows: drawn.map((x) => ({ label: x.text, value: x.median, text: hoursOf(t, x.median) })) },
          // what the bars draw, two columns that fit a phone; the tables under the chart have every figure
          table: {
            columns: [t('bottlenecks.columns.position'), t('bottlenecks.columns.median')],
            rows: drawn.map((x) => [{ text: x.text }, { text: hoursOf(t, x.median) }]),
          },
        }
      : null,
    positionColumns: figureColumns({ key: 'position', header: t('bottlenecks.columns.position'), numeric: false }),
    positionRows: named.map((x) => ({ id: x.at, cells: { position: { text: x.text }, ...figures(x) } })),
    personColumns: figureColumns({ key: 'person', header: t('bottlenecks.columns.person'), numeric: false }),
    personRows: b.byPerson.map((x) => ({ id: x.memberId, cells: { person: { text: x.name || t('bottlenecks.noName') }, ...figures(x) } })),
  }
}

// ---------- decisions outside DOA (BR-RPT-05) ----------

const KINDS = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'WORKFLOW_VERSION', 'ORG_AUTHORITY_CHANGE', 'BUDGET_TRANSFER', 'BUDGET_OVERRUN'] as const
const kindText = (t: WorkflowT, type: string) => t(`wrongDoa.kinds.${(KINDS as readonly string[]).includes(type) ? (type as (typeof KINDS)[number]) : 'OTHER'}`)

export interface WrongDoaView {
  readonly summary: string
  readonly columns: readonly ReportColumnView[]
  readonly rows: readonly ReportRowView[]
}

export function wrongDoaView(t: WorkflowT, locale: string, items: WorkflowReport['wrongDoa'], rights: LinkRights): WrongDoaView {
  const count = (reason: WorkflowReport['wrongDoa'][number]['reason']) => items.filter((x) => x.reason === reason).length
  return {
    summary: t('wrongDoa.summary', { count: items.length, notByDoa: count('NOT_BY_DOA'), noReference: count('NO_DOA_REFERENCE'), split: count('SPLIT') }),
    columns: [
      { key: 'document', header: t('wrongDoa.columns.document'), numeric: false },
      { key: 'reason', header: t('wrongDoa.columns.reason'), numeric: false },
      { key: 'at', header: t('wrongDoa.columns.at'), numeric: false },
    ],
    rows: [...items]
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((x) => ({
        id: x.key,
        cells: {
          // a document the reader may not open stays text (links.ts); the page behind checks again
          document: { text: x.number ?? kindText(t, x.subjectType), href: documentHref({ type: x.subjectType, id: x.subjectId }, rights) },
          reason: { text: t(`wrongDoa.reasons.${x.reason}`) },
          at: { text: formatDateTime(locale, x.at) },
        },
      })),
  }
}

// ---------- heatmap (BR-RPT-06) ----------

const LEVELS = 4

/** The level of a count among counts up to `max`: 0 for nothing, then quarters of the largest (1 to 4) */
export function heatLevel(count: number, max: number): HeatLevel {
  if (count <= 0 || max <= 0) return 0
  return Math.min(LEVELS, Math.max(1, Math.ceil((count * LEVELS) / max))) as HeatLevel
}

/** What each level stands for, in counts: the levels no count can reach are left out */
export function heatLegend(t: WorkflowT, max: number): HeatLegendItem[] {
  const items: HeatLegendItem[] = []
  for (let level = 1; level <= LEVELS; level++) {
    const from = Math.floor((max * (level - 1)) / LEVELS) + 1
    const to = Math.floor((max * level) / LEVELS)
    if (from > to) continue
    items.push({ level: level as HeatLevel, text: from === to ? t('heatmap.legendOne', { value: from }) : t('heatmap.legendRange', { from, to }) })
  }
  return items
}

/** The week as the organization reads it, Monday first */
export const WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
const HOURS = Array.from({ length: 24 }, (_, h) => h)
const two = (n: number) => String(n).padStart(2, '0')

export interface HeatView {
  readonly spec: HeatSpec
  readonly legend: readonly HeatLegendItem[]
  readonly table: InsightTableView
}

/** Decisions by weekday and hour: the days as rows and the 24 hours as columns (turned on a phone); null when none */
export function decisionsHeat(t: WorkflowT, decisions: WorkflowReport['heatmap']['decisions']): HeatView | null {
  const counts = new Map(decisions.map((d) => [`${d.weekday}|${d.hour}`, d.count]))
  const countOf = (day: string, hour: number) => counts.get(`${day}|${hour}`) ?? 0
  const max = Math.max(0, ...decisions.map((d) => d.count))
  if (max === 0) return null
  return {
    spec: {
      turnOnPhone: true,
      columns: HOURS.map((h) => ({ key: String(h), label: t('heatmap.hour', { hour: two(h) }), short: two(h) })),
      rows: WEEK.map((day) => ({ key: day, label: t(`heatmap.weekdays.${day}`), short: t(`heatmap.weekdaysShort.${day}`), cells: HOURS.map((h) => ({ count: countOf(day, h), level: heatLevel(countOf(day, h), max) })) })),
    },
    legend: heatLegend(t, max),
    table: {
      columns: [t('heatmap.slotHeader'), t('heatmap.countHeader')],
      rows: WEEK.flatMap((day) => HOURS.filter((h) => countOf(day, h) > 0).map((h) => [{ text: `${t(`heatmap.weekdays.${day}`)} ${t('heatmap.hourRange', { from: two(h), to: two(h) })}` }, { text: String(countOf(day, h)) }])),
    },
  }
}

const BANDS: readonly AgeBand[] = ['H0_8', 'H8_16', 'H16_40', 'H40_PLUS']

/** Open tasks by department and age band: a row per department by name, the tasks of no department's request last */
export function openHeat(t: WorkflowT, locale: string, open: WorkflowReport['heatmap']['openByDepartment'], departments: readonly DepartmentRow[]): HeatView | null {
  const max = Math.max(0, ...open.flatMap((o) => BANDS.map((b) => o.bands[b])))
  if (max === 0) return null
  const nameOf = (o: (typeof open)[number]) => {
    const d = o.departmentId ? departments.find((x) => x.id === o.departmentId) : undefined
    if (d) return locale === 'en' && d.nameEn ? d.nameEn : d.nameTh
    return o.code ?? t('heatmap.noDepartment')
  }
  const rows = open
    .map((o) => ({ key: o.departmentId ?? 'none', name: nameOf(o), none: o.departmentId === null, bands: o.bands }))
    .sort((a, b) => Number(a.none) - Number(b.none) || a.name.localeCompare(b.name, 'th'))
  return {
    spec: {
      turnOnPhone: false,
      columns: BANDS.map((b) => ({ key: b, label: t(`heatmap.bands.${b}`), short: t(`heatmap.bands.${b}`) })),
      rows: rows.map((r) => ({ key: r.key, label: r.name, short: r.name, cells: BANDS.map((b) => ({ count: r.bands[b], level: heatLevel(r.bands[b], max) })) })),
    },
    legend: heatLegend(t, max),
    table: {
      columns: [t('heatmap.departmentHeader'), ...BANDS.map((b) => t(`heatmap.bands.${b}`)), t('heatmap.totalHeader')],
      rows: rows.map((r) => [{ text: r.name }, ...BANDS.map((b) => ({ text: String(r.bands[b]) })), { text: String(BANDS.reduce((sum, b) => sum + r.bands[b], 0)) }]),
    },
  }
}
