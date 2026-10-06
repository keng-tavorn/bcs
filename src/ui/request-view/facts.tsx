import type { ReactNode } from 'react'
import { cn } from '../cn'

// Label–value pairs of a document (who, which department, when). Flat: no card, a rule above the group.

export interface Fact {
  readonly label: string
  readonly value: ReactNode
}

/**
 * How the pairs fall into columns:
 *  - 'screen' (the default): one column on a phone, two from the screen's sm width;
 *  - 'one': one column at every width;
 *  - 2 or 3: by the width of the list itself — a container of its own — never the screen's, so a part the workspace and
 *    LIFF share is as narrow on a LIFF page as that page looks (§9.9 "LIFF เป็นคอลัมน์เดียว"): one column below 36rem,
 *    as a phone and the LIFF column (34rem at most, whatever the screen) always are; two from 36rem; with 3, three from
 *    40rem — the document's column of a wide workspace. Tailwind reads each class whole, so they are written out.
 */
export type FactColumns = 'screen' | 'one' | 2 | 3

/** The columns of a list of facts that fits its own container (FactColumns 2 and 3), for lists that line up with Facts */
export const FIT_COLUMNS = { 2: '@min-[36rem]:grid-cols-2', 3: '@min-[36rem]:grid-cols-2 @min-[40rem]:grid-cols-3' } as const

export function Facts({ items, className, columns = 'screen' }: { items: readonly Fact[]; className?: string; columns?: FactColumns }) {
  const list = (
    <dl className={cn('grid gap-x-8 gap-y-3', columns === 'screen' ? 'sm:grid-cols-2' : columns === 'one' ? null : FIT_COLUMNS[columns], className)}>
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col">
          <dt className="text-base text-ink-muted md:text-sm">{item.label}</dt>
          <dd className="break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  )
  // A container query asks an ancestor: the list's own wrapper, whatever the page around it
  return columns === 2 || columns === 3 ? <div className="@container">{list}</div> : list
}

export interface AmountRow {
  readonly label: string
  /** Already formatted: thousands separators and 2 decimals (FR-PLT-002 AC3) */
  readonly value: string
  readonly total?: boolean
}

/**
 * Money right-aligned with tabular digits (§9.9 principle 6); the unit heads the column and is read with each amount. At
 * most 28rem wide in the workspace; on a LIFF page as wide as its one column (liff-type sets --amounts-max-width), so
 * its figures end at the column's right edge with those of the lines and quotations.
 */
export function Amounts({ rows, heading, unit }: { rows: readonly AmountRow[]; heading: string; unit: string }) {
  return (
    <div className="flex w-full max-w-[var(--amounts-max-width,28rem)] flex-col">
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
