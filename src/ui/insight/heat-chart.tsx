'use client'

import dynamic from 'next/dynamic'
import { useId, useState } from 'react'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { InsightTable, type InsightChartTexts, type InsightTableView } from './insight-chart'

// A heatmap of the workflow reports (spec §9.10, FR-VIS-101 AC3, BR-RPT-06): a caption naming what is counted and its
// unit, the grid — loaded with import() only when the tab is drawn in the browser, like every chart of the insight
// screens — the colour levels with the counts each stands for, and a button that shows the same counts as a table. The
// cells are tints of --chart-1 (one series, darker is more) and carry their count, so no figure is told by colour alone.
// Texts arrive translated.

const HeatGridBody = dynamic(() => import('./heat-grid').then((m) => m.HeatGridBody), { ssr: false, loading: () => <Skeleton className="h-40 w-full" /> })

/** 0 is an empty cell; 1 to 4 are ever darker tints of --chart-1 */
export type HeatLevel = 0 | 1 | 2 | 3 | 4

export interface HeatAxisItem {
  readonly key: string
  /** Where there is room: a row's name on wide screens, a row's name on phones when the grid turns */
  readonly label: string
  /** A column's head */
  readonly short: string
}

export interface HeatSpec {
  readonly columns: readonly HeatAxisItem[]
  readonly rows: ReadonlyArray<HeatAxisItem & { readonly cells: ReadonlyArray<{ readonly count: number; readonly level: HeatLevel }> }>
  /** Phones show the grid turned (the columns as rows), when there are too many columns for a phone's width */
  readonly turnOnPhone: boolean
}

export interface HeatLegendItem {
  readonly level: HeatLevel
  readonly text: string
}

/** The tint of a level: literal classes, so Tailwind writes them */
export const HEAT_CLASSES: Readonly<Record<HeatLevel, string>> = {
  0: 'bg-bg',
  1: 'bg-chart-1/15',
  2: 'bg-chart-1/30',
  3: 'bg-chart-1/45',
  4: 'bg-chart-1/60',
}

export function HeatChart({ caption, unit, spec, legend, legendLabel, table, texts }: { caption: string; unit: string; spec: HeatSpec; legend: readonly HeatLegendItem[]; legendLabel: string; table: InsightTableView; texts: InsightChartTexts }) {
  const [asTable, setAsTable] = useState(false)
  const id = useId()
  return (
    <figure className="flex min-w-0 flex-col gap-3" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`} className="flex flex-col">
        <span className="font-medium text-ink">{caption}</span>
        <span className="text-base text-ink-muted md:text-sm">{unit}</span>
      </figcaption>
      {asTable ? (
        <InsightTable table={table} />
      ) : (
        <>
          <HeatGridBody spec={spec} />
          <ul aria-label={legendLabel} className="flex flex-wrap gap-x-4 gap-y-2">
            {legend.map((item) => (
              <li key={item.level} className="flex items-center gap-2 text-base text-ink md:text-sm">
                <span aria-hidden="true" className={`size-4 shrink-0 rounded-sm border border-line ${HEAT_CLASSES[item.level]}`} />
                <span className="tabular">{item.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button type="button" variant="outline" className="h-11 self-start text-base md:h-9 md:text-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
        {asTable ? texts.showChart : texts.showTable}
      </Button>
    </figure>
  )
}
