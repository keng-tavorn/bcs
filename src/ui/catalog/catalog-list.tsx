import { cn } from '../cn'
import { StatusBadge } from '../document/badges'

// Rows of the catalogue (/catalog · S6-10 · FR-INT-102 AC1): the item with its code, category and unit, its reference
// price before VAT, and each agreed price in effect today as the badge "ราคาตกลง" with its supplier, price and last day.
// Wide screens line the parts up in columns under one header row; phones stack them, never a table that scrolls
// sideways (§9.9). Strings arrive translated and formatted (money with two decimals, §9.9 principle 6).

export interface CatalogRow {
  readonly id: string
  readonly name: string
  readonly meta: string
  readonly reference: string
  readonly agreements: ReadonlyArray<{ readonly id: string; readonly text: string; readonly until: string }>
  /** Said when the item has no agreed price in effect */
  readonly none: string
}

export interface CatalogListLabels {
  readonly list: string
  readonly item: string
  readonly reference: string
  readonly agreed: string
  readonly agreedBadge: string
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.4fr)] md:items-start md:gap-6'

export function CatalogList({ rows, labels }: { rows: readonly CatalogRow[]; labels: CatalogListLabels }) {
  return (
    <div className="flex flex-col">
      <div className={cn('hidden border-b border-line pb-2 text-sm text-ink-muted', GRID)} aria-hidden="true">
        <span>{labels.item}</span>
        <span className="text-right">{labels.reference}</span>
        <span>{labels.agreed}</span>
      </div>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line">
        {rows.map((row) => (
          <li key={row.id} className={cn('flex flex-col gap-1.5 py-3', GRID)}>
            <div className="flex min-w-0 flex-col">
              <span className="font-semibold break-words text-ink">{row.name}</span>
              <span className="text-base break-words text-ink-muted md:text-sm">{row.meta}</span>
            </div>
            <div className="flex flex-col md:items-end">
              <span className="sr-only">{labels.reference}: </span>
              <span className="text-ink tabular-nums md:text-right">{row.reference}</span>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="sr-only">{labels.agreed}: </span>
              {row.agreements.length ? (
                row.agreements.map((a) => (
                  <span key={a.id} className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusBadge look={{ tone: 'info', icon: 'Lock' }} label={labels.agreedBadge} />
                      <span className="break-words text-ink tabular-nums">{a.text}</span>
                    </span>
                    <span className="text-base text-ink-muted md:text-sm">{a.until}</span>
                  </span>
                ))
              ) : (
                <span className="text-base text-ink-muted md:text-sm">{row.none}</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
