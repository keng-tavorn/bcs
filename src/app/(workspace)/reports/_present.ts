import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { THAI_TIME_ZONE } from '@/core/thai'
import type { Column } from '@/server/services/reports'
import { dayIn, daysBefore } from '@/ui/insight/format'
import type { ReportColumnView, ReportRowView } from '@/ui/insight/report-table'

// The report screen's parameters and result (spec §11.3, FR-VIS-002 AC1 AC3): the period in Thai days from the address
// (GET), the columns in the reader's language from the messages (FR-PLT-002 AC2; the file's unit and code columns stay
// in the file), and the KPI report's cells in words — what each measure is, a share with its percent sign, a time in
// business hours with one decimal as on the KPI page, an empty value read as "not computable yet".

// The translator's type comes from a call: an instantiation expression over the namespace costs the checker far more
const _reportsTranslator = () => getTranslations('reports')
export type ReportsT = Awaited<ReturnType<typeof _reportsTranslator>>
type Params = Record<string, string | string[] | undefined>

/** The report periods the screens open with: the last 30 days (a schedule's period too) */
export const DEFAULT_REPORT_DAYS = 30
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
const DAY = z.iso.date()

/** Reports the screen has words for; a report without them shows its code */
export const NAMED_REPORTS = ['KPI'] as const
export type NamedReport = (typeof NAMED_REPORTS)[number]
export const isNamed = (code: string): code is NamedReport => (NAMED_REPORTS as readonly string[]).includes(code)

/** The period from the address, or the last `days` days; `invalid` when the address asked for a period that cannot be */
export function periodFrom(params: Params, now: Date, days: number): { from: string; to: string; invalid: boolean } {
  const today = dayIn(now, THAI_TIME_ZONE)
  const fallback = { from: daysBefore(today, days - 1), to: today }
  const from = one(params.from)
  const to = one(params.to)
  if (from === undefined && to === undefined) return { ...fallback, invalid: false }
  if (!from || !to || !DAY.safeParse(from).success || !DAY.safeParse(to).success || from > to) return { ...fallback, invalid: true }
  return { from, to, invalid: false }
}

const KPI_MEASURES = [
  'PO_APPROVED_OVER_ACCOUNTING_PURCHASES',
  'DECISIONS_NOT_BY_DOA',
  'DECISIONS_WITH_DOA_REFERENCE',
  'MEDIAN_SUBMIT_TO_FIRST_PO_HOURS',
  'MEDIAN_DECISION_HOURS',
  'TASKS_PAST_DUE',
  'TASKS_ON_FAILED_BUDGET_CHECK',
  'DECISIONS_ON_LINE_ALL',
] as const
const KINDS = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const

/** A KPI measure code of the report in words */
export function measureText(t: ReportsT, code: string): string {
  if ((KPI_MEASURES as readonly string[]).includes(code)) return t(`measures.${code as (typeof KPI_MEASURES)[number]}`)
  const kind = code.startsWith('DECISIONS_ON_LINE_') ? code.slice('DECISIONS_ON_LINE_'.length) : null
  if (kind && (KINDS as readonly string[]).includes(kind)) return t('measures.decisionsOnLineOf', { kind: t(`kinds.${kind as (typeof KINDS)[number]}`) })
  return code
}

/** Columns the screen has words for; a report's other columns keep the header the report gives */
const COLUMN_KEYS = ['kpi', 'name', 'value', 'numerator', 'denominator'] as const
type ColumnKey = (typeof COLUMN_KEYS)[number]
const TEXT_COLUMNS: ReadonlySet<string> = new Set(['kpi', 'name', 'measure'])
/** The KPI measures whose value is a business time */
const TIME_MEASURES: ReadonlySet<string> = new Set(['MEDIAN_SUBMIT_TO_FIRST_PO_HOURS', 'MEDIAN_DECISION_HOURS'])

export function columnViews(t: ReportsT, columns: readonly Column[], locale: string): ReportColumnView[] {
  return columns
    .filter((c) => !c.fileOnly)
    .map((c) => ({
      key: c.key,
      header: (COLUMN_KEYS as readonly string[]).includes(c.key) ? t(`columns.${c.key as ColumnKey}`) : locale === 'en' ? c.header.en : c.header.th,
      numeric: !TEXT_COLUMNS.has(c.key),
    }))
}

/** The rows of a report as cells; the KPI report's measure, value, numerator and denominator get their words */
export function rowViews(t: ReportsT, code: string, rows: ReadonlyArray<Record<string, string>>): ReportRowView[] {
  return rows.map((r, i) => {
    if (code !== 'KPI') return { id: String(i), cells: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { text: v }])) }
    const ratio = r.denominator !== '' && r.denominator !== undefined
    const time = TIME_MEASURES.has(r.measure ?? '')
    const value = !r.value ? '' : ratio ? t('units.percent', { value: r.value }) : time ? t('units.hours', { value: r.value }) : t('units.count', { value: r.value })
    return {
      id: `${r.kpi}-${r.measure}`,
      cells: {
        kpi: { text: r.kpi ?? '' },
        // the measure in the reader's language from the messages, by its code (the file carries the Thai name)
        name: { text: measureText(t, r.measure ?? '') },
        value: { text: value, emptyLabel: t('units.notYet') },
        numerator: { text: r.numerator ?? '', emptyLabel: t('units.none') },
        denominator: { text: r.denominator ?? '', emptyLabel: t('units.none') },
      },
    }
  })
}
