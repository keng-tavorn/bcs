'use client'

import { cn } from '../cn'
import { HEAT_CLASSES, type HeatSpec } from './heat-chart'

// The grid of a heatmap (FR-VIS-101 AC3, BR-RPT-06), reached through import() from heat-chart.tsx only: a cell per row
// and column, tinted by its level and carrying its count (empty when nothing was counted). Wide screens lay the rows
// out as given; a grid with many columns (the 24 hours of a day) turns on a phone, its columns becoming rows, so the
// page never scrolls sideways (§9.9). The same counts are in the table view, which is what screen readers are offered.

const CELL = 'flex min-h-8 items-center justify-center rounded-sm border border-line text-base tabular text-ink md:text-sm'
const HEAD = 'flex min-h-8 items-center text-base text-ink-muted md:text-sm'

function Grid({ spec, turned, className }: { spec: HeatSpec; turned: boolean; className: string }) {
  const across = turned ? spec.rows : spec.columns
  const down = turned ? spec.columns : spec.rows
  const countAt = (d: number, a: number) => (turned ? spec.rows[a]!.cells[d]! : spec.rows[d]!.cells[a]!)
  // short row names (days, hours) keep their width; long ones (departments) share the row and wrap
  const names = spec.turnOnPhone ? 'minmax(3.5rem, max-content)' : 'minmax(0, 2fr)'
  return (
    <div aria-hidden="true" className={cn('gap-1', className)} style={{ gridTemplateColumns: `${names} repeat(${across.length}, minmax(0, 1fr))` }}>
      <span />
      {across.map((c) => (
        <span key={c.key} className={cn(HEAD, 'justify-center text-center')}>
          {c.short}
        </span>
      ))}
      {down.map((r, d) => (
        <div key={r.key} className="contents">
          <span className={cn(HEAD, 'min-w-0 pr-2 break-words')}>{r.label}</span>
          {across.map((c, a) => {
            const cell = countAt(d, a)
            return (
              <span key={c.key} className={cn(CELL, HEAT_CLASSES[cell.level])}>
                {cell.count > 0 ? cell.count : ''}
              </span>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function HeatGridBody({ spec }: { spec: HeatSpec }) {
  if (!spec.turnOnPhone) return <Grid spec={spec} turned={false} className="grid" />
  return (
    <>
      <Grid spec={spec} turned className="grid lg:hidden" />
      <Grid spec={spec} turned={false} className="hidden lg:grid" />
    </>
  )
}
