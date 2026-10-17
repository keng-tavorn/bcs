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
/** A name longer than fits ends in "…"; the table view and the tooltip have it whole */
const LABEL_CHARS = 17
/**
 * Each category is a line naming it (and, for the spending bars, its amount) above a bar as wide as the card: a card is
 * about 240 px wide in the four columns of a 1280 px screen (§9.10), too narrow for names beside the bars as well.
 */
const ROW_PX = 52
const BAR_PX = 22
const NAME_GAP_PX = 6
/** Room above the first bar for its name */
const TOP_PX = 12
const LEGEND_PX = 40
const AXIS_PX = 24
/** A segment carries its percentage only when it is wide enough on screen to hold it */
const SEGMENT_LABEL_MIN_PX = 40
const HALF = 2

const shortLabel = (label: string) => (label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1)}…` : label)

const percentLabel = (value: unknown) => (typeof value === 'number' && value >= LABEL_MIN_BP ? `${Math.floor(value / PERCENT_BP)}%` : '')

/** Where recharts draws a label: the box of its bar, and which row it is */
interface LabelBox {
  readonly x?: number | string
  readonly y?: number | string
  readonly width?: number | string
  readonly height?: number | string
  readonly index?: number
  readonly value?: unknown
}

/**
 * The line above a category's bar, from the start of the plot: its name, and its amount when it has one. Drawn as the
 * category axis's tick (mirrored into the plot, the axis 1 px wide), so every row has it whatever its values.
 */
function rowName(rows: ReadonlyArray<{ readonly name: string; readonly text?: string }>) {
  return function RowName({ x, y, index }: LabelBox) {
    const row = rows[index ?? 0]
    if (!row) return null
    return (
      <text x={Number(x)} y={Number(y) - BAR_PX / HALF - NAME_GAP_PX} className="fill-ink tabular">
        {row.text ? `${shortLabel(row.name)} · ${row.text}` : shortLabel(row.name)}
      </text>
    )
  }
}

/**
 * A stacked segment's percentage, inside it, only when the segment is wide enough on screen. Ink outlined in --bg (P1-09):
 * the middle green of the budget (--budget-committed) is too close to both ink and white for 4.5:1, so the outline makes
 * the letters their own light ground on every segment
 */
function SegmentPercent({ x, y, width, height, value }: LabelBox) {
  const text = percentLabel(value)
  if (!text || Number(width) < SEGMENT_LABEL_MIN_PX) return null
  return (
    <text
      x={Number(x) + Number(width) / HALF}
      y={Number(y) + Number(height) / HALF}
      textAnchor="middle"
      dominantBaseline="central"
      className="fill-ink stroke-bg tabular [paint-order:stroke] [stroke-linejoin:round] [stroke-width:4px]"
    >
      {text}
    </text>
  )
}

function Bars({ spec }: { spec: BarsSpec }) {
  const config = { value: { label: spec.series, color: SERIES_COLORS[0] } } satisfies ChartConfig
  const data = spec.rows.map((r) => ({ name: r.label, value: r.value, text: r.text }))
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: `${Math.max(2, data.length) * ROW_PX + LEGEND_PX + TOP_PX}px` }}>
      <BarChart data={data} layout="vertical" margin={{ top: TOP_PX, left: 0, right: 0 }} barSize={BAR_PX}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" dataKey="name" width={1} mirror tick={rowName(data)} tickLine={false} axisLine={false} interval={0} />
        <ChartTooltip content={<ChartTooltipContent hideIndicator formatter={(_, __, item) => (item.payload as { text: string }).text} />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="value" fill="var(--color-value)" radius={4} isAnimationActive={false}>
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

function Stacked({ spec }: { spec: StackedSpec }) {
  const config = Object.fromEntries(spec.series.map((s) => [s.key, { label: s.label, color: s.color }])) satisfies ChartConfig
  const data = spec.rows.map((r) => ({ name: r.label, ...r.values, texts: r.texts }))
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: `${Math.max(2, data.length) * ROW_PX + LEGEND_PX + AXIS_PX + TOP_PX}px` }}>
      <BarChart data={data} layout="vertical" margin={{ top: TOP_PX, left: 0, right: 16 }} barSize={BAR_PX}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" domain={[0, spec.max]} tickFormatter={(v: number) => `${Math.round(v / PERCENT_BP)}%`} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={1} mirror tick={rowName(data)} tickLine={false} axisLine={false} interval={0} />
        <ChartTooltip content={<ChartTooltipContent formatter={(_, key, item) => `${config[key as string]?.label ?? ''} ${(item.payload as { texts: Record<string, string> }).texts[key as string] ?? ''}`} />} />
        <ChartLegend content={<ChartLegendContent />} />
        {spec.series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} stackId="budget" fill={`var(--color-${s.key})`} stroke="var(--bg)" strokeWidth={2} radius={i === spec.series.length - 1 ? [0, 4, 4, 0] : 0} isAnimationActive={false}>
            <LabelList dataKey={s.key} content={SegmentPercent} />
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
