'use client'

import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/ui/shadcn/chart'

// The charts of /insights (spec §9.10, FR-VIS-007 AC2 AC5): one chart per card, never more than six colours, the
// series' colours in their fixed order (--chart-1 …, the budget tokens for the budget card), the unit in the caption and
// a legend under every chart. Texts arrive translated; values arrive as plain numbers made for drawing only — money
// never: a bar's length is its share of the longest bar in basis points and its label is the money text. Loaded with
// import() by insight-chart.tsx, so recharts is not in the page's first JavaScript (AC5); the table view lives there.

export interface BarsSpec {
  readonly kind: 'bars'
  readonly series: string
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: number; readonly text: string }>
}

export interface StackedSpec {
  readonly kind: 'stacked'
  /** Up to three series, in the order they stack, each with its colour token */
  readonly series: ReadonlyArray<{ readonly key: string; readonly label: string; readonly color: string }>
  readonly rows: ReadonlyArray<{ readonly label: string; readonly values: Readonly<Record<string, number>>; readonly texts: Readonly<Record<string, string>> }>
  /** The longest the axis needs to be (basis points; 10,000 is 100 %) */
  readonly max: number
}

export interface LineSpec {
  readonly kind: 'line'
  readonly series: string
  readonly unit: string
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: number | null }>
}

export interface ShareSpec {
  readonly kind: 'share'
  readonly label: string
  /** One segment per series, in the fixed order of the colours */
  readonly series: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: number; readonly text: string }>
}

export type InsightChartSpec = BarsSpec | StackedSpec | LineSpec | ShareSpec

const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)'] as const
/** A stacked segment carries its number on the bar when it is at least this wide (basis points); the table has them all */
const LABEL_MIN_BP = 800
const PERCENT_BP = 100
/** Room for a category's name beside its bar: wide enough for most department names, never more than a third of a phone */
const LABEL_MAX = 136
const LABEL_MIN = 64
const PX_PER_CHAR = 8
/** A name longer than fits ends in "…"; the table view and the tooltip have it whole */
const LABEL_CHARS = Math.floor(LABEL_MAX / PX_PER_CHAR)

const labelWidth = (labels: readonly string[]) => Math.min(LABEL_MAX, Math.max(LABEL_MIN, ...labels.map((l) => l.length * PX_PER_CHAR)))
const shortLabel = (label: string) => (label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label)

const percentLabel = (value: unknown) => (typeof value === 'number' && value >= LABEL_MIN_BP ? `${Math.floor(value / PERCENT_BP)}%` : '')

function Bars({ spec }: { spec: BarsSpec }) {
  const config = { value: { label: spec.series, color: SERIES_COLORS[0] } } satisfies ChartConfig
  const data = spec.rows.map((r) => ({ name: r.label, value: r.value, text: r.text }))
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: `${Math.max(2, data.length) * 40 + 40}px` }}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 112 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" dataKey="name" width={labelWidth(data.map((d) => d.name))} tickFormatter={shortLabel} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent hideIndicator formatter={(_, __, item) => (item.payload as { text: string }).text} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={4} isAnimationActive={false}>
          <LabelList dataKey="text" position="right" className="fill-ink tabular" />
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

function Stacked({ spec }: { spec: StackedSpec }) {
  const config = Object.fromEntries(spec.series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig
  const data = spec.rows.map((r) => ({ name: r.label, ...r.values, texts: r.texts }))
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: `${Math.max(2, data.length) * 40 + 64}px` }}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16 }} barCategoryGap={8}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" domain={[0, spec.max]} tickFormatter={(v: number) => `${Math.round(v / PERCENT_BP)}%`} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={labelWidth(data.map((d) => d.name))} tickFormatter={shortLabel} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent formatter={(_, key, item) => `${config[key as string]?.label ?? ''} ${(item.payload as { texts: Record<string, string> }).texts[key as string] ?? ''}`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {spec.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} stackId="budget" fill={`var(--color-${s.key})`} stroke="var(--bg)" strokeWidth={2} radius={i === spec.series.length - 1 ? [0, 4, 4, 0] : 0} isAnimationActive={false}>
            <LabelList dataKey={s.key} position="center" formatter={percentLabel} className="fill-ink tabular" />
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  )
}

function Trend({ spec }: { spec: LineSpec }) {
  const config = { value: { label: spec.series, color: SERIES_COLORS[0] } } satisfies ChartConfig
  const data = spec.rows.map((r) => ({ name: r.label, value: r.value }))
  return (
    <ChartContainer config={config} className="aspect-auto h-56 w-full">
      <LineChart data={data} margin={{ left: 0, right: 16, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="name" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
        <YAxis width={48} tickLine={false} axisLine={false} allowDecimals={false} label={{ value: spec.unit, angle: -90, position: 'insideLeft', className: 'fill-ink-muted' }} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Line dataKey="value" type="linear" stroke="var(--color-value)" strokeWidth={2} dot={{ r: 4, fill: 'var(--color-value)', stroke: 'var(--bg)', strokeWidth: 2 }} activeDot={{ r: 5, fill: 'var(--color-value)', stroke: 'var(--bg)', strokeWidth: 2 }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  )
}

function Share({ spec }: { spec: ShareSpec }) {
  const config = Object.fromEntries(spec.series.map((s, i) => [s.key, { label: s.label, color: SERIES_COLORS[i] }])) satisfies ChartConfig
  const texts = Object.fromEntries(spec.series.map((s) => [s.key, s.text]))
  const data = [{ name: spec.label, ...Object.fromEntries(spec.series.map((s) => [s.key, s.value])) }]
  return (
    <ChartContainer config={config} className="aspect-auto h-32 w-full">
      <BarChart data={data} layout="vertical" stackOffset="expand" margin={{ left: 0, right: 16 }}>
        <XAxis type="number" tickFormatter={(v: number) => `${Math.round(v * PERCENT_BP)}%`} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" hide />
        <ChartTooltip content={<ChartTooltipContent formatter={(_, key) => `${config[key as string]?.label ?? ''} ${texts[key as string] ?? ''}`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {spec.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} stackId="share" fill={`var(--color-${s.key})`} stroke="var(--bg)" strokeWidth={2} radius={i === spec.series.length - 1 ? [0, 4, 4, 0] : 0} isAnimationActive={false} />
        ))}
      </BarChart>
    </ChartContainer>
  )
}

export function InsightChartBody({ spec }: { spec: InsightChartSpec }) {
  if (spec.kind === 'bars') return <Bars spec={spec} />
  if (spec.kind === 'stacked') return <Stacked spec={spec} />
  if (spec.kind === 'line') return <Trend spec={spec} />
  return <Share spec={spec} />
}
