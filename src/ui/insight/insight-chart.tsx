'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useId, useState } from 'react'
import { Button } from '@/ui/shadcn/button'
import { Skeleton } from '@/ui/shadcn/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/shadcn/table'
import type { InsightChartSpec } from './insight-charts'

// One chart of an /insights card with its table (spec §9.10, FR-VIS-007 AC2 AC5): a caption that names what is drawn
// and its unit, the chart — loaded with import() only when the card is drawn in the browser, so recharts is not in the
// page's first JavaScript — and a button that shows the same figures as a table, where every number opens its list
// (§9.9). Texts arrive translated.

// while the chart's code loads, a quiet placeholder of the chart's height (the table button already works)
const InsightChartBody = dynamic(() => import('./insight-charts').then((m) => m.InsightChartBody), { ssr: false, loading: () => <Skeleton className="h-40 w-full" /> })

export interface InsightTableView {
  readonly columns: readonly string[]
  /** The first cell names the row; the others are figures, right aligned, each opening its list when it has one */
  readonly rows: ReadonlyArray<ReadonlyArray<{ readonly text: string; readonly href?: string | null }>>
}

export interface InsightChartTexts {
  readonly showTable: string
  readonly showChart: string
}

const linkClass = 'text-primary underline underline-offset-4 hover:no-underline'

export function InsightChart({ caption, unit, spec, table, texts }: { caption: string; unit: string; spec: InsightChartSpec; table: InsightTableView; texts: InsightChartTexts }) {
  const [asTable, setAsTable] = useState(false)
  const id = useId()
  return (
    <figure className="flex flex-col gap-3" aria-labelledby={`${id}-caption`}>
      <figcaption id={`${id}-caption`} className="flex flex-col">
        <span className="font-medium text-ink">{caption}</span>
        <span className="text-base text-ink-muted md:text-sm">{unit}</span>
      </figcaption>
      {asTable ? (
        <InsightTable table={table} />
      ) : (
        <InsightChartBody spec={spec} />
      )}
      <Button type="button" variant="outline" className="h-11 self-start text-base md:h-9 md:text-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
        {asTable ? texts.showChart : texts.showTable}
      </Button>
    </figure>
  )
}

/** The figures of a chart as a table: the first cell names the row, the others right aligned, each opening its list */
export function InsightTable({ table }: { table: InsightTableView }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {table.columns.map((c, i) => (
            <TableHead key={c} className={i === 0 ? undefined : 'text-right'}>
              {c}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {table.rows.map((row, r) => (
          <TableRow key={`${r}:${row[0]?.text}`}>
            {row.map((cell, i) =>
              i === 0 ? (
                <TableHead key={i} scope="row" className="font-normal whitespace-normal text-ink">
                  {cell.text}
                </TableHead>
              ) : (
                <TableCell key={i} className="money">
                  {cell.href ? (
                    <Link href={cell.href} className={linkClass}>
                      {cell.text}
                    </Link>
                  ) : (
                    cell.text
                  )}
                </TableCell>
              ),
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
