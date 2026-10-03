import type { ReactNode } from 'react'
import { cn } from '../cn'

// Label–value pairs of a document (who, which department, when). Flat: no card, a rule above the group.

export interface Fact {
  readonly label: string
  readonly value: ReactNode
}

export function Facts({ items, className }: { items: readonly Fact[]; className?: string }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-3 sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col">
          <dt className="text-base text-ink-muted md:text-sm">{item.label}</dt>
          <dd className="break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface AmountRow {
  readonly label: string
  /** Already formatted: thousands separators and 2 decimals (FR-PLT-002 AC3) */
  readonly value: string
  readonly total?: boolean
}

/** Money right-aligned with tabular digits (§9.9 principle 6); the unit heads the column and is read with each amount */
export function Amounts({ rows, heading, unit }: { rows: readonly AmountRow[]; heading: string; unit: string }) {
  return (
    <div className="flex w-full max-w-md flex-col">
      <p className="pb-1 text-right text-base text-ink-muted md:text-sm" aria-hidden="true">
        {heading}
      </p>
      <dl className="flex flex-col">
        {rows.map((row) => (
          <div key={row.label} className={cn('flex items-baseline justify-between gap-4 py-1.5', row.total && 'border-t border-line pt-2 font-semibold')}>
            <dt className={row.total ? 'text-ink' : 'text-ink-muted'}>{row.label}</dt>
            <dd className="money text-ink">
              {row.value}
              <span className="sr-only"> {unit}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** A titled part of a document page */
export function Section({ id, title, children, className, action }: { id: string; title: string; children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <section aria-labelledby={id} className={cn('flex flex-col gap-3 border-t border-line pt-5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={id} className="text-lg font-semibold text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}
