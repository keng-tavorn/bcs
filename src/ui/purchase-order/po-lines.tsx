import { CircleCheck, TriangleAlert } from 'lucide-react'
import Link from 'next/link'

// The lines of a purchase order (FR-P2P-003, BR-CONS-04): each item with the request lines it orders (links), the
// quantity, unit price and amount before VAT right-aligned in tabular digits, what was received, and the prices paid
// for the same item on the last approved POs with a warning when the new price is too far above the last one (AC1) —
// an icon and words, never colour alone. Wide screens: columns; phones: each line stacks with the numbers next to
// their labels — never a table that scrolls sideways (§9.9). Strings and numbers arrive translated and formatted.

export interface PoLineView {
  readonly key: string
  readonly title: string
  readonly notes: readonly string[]
  /** The request lines it orders; href is null when the reader may not open that request (plain text, never a refusal) */
  readonly sources: ReadonlyArray<{ readonly href: string | null; readonly label: string }>
  readonly quantity: string
  readonly unitPrice: string
  readonly amount: string
  /** null when the reader does not see the prices of other POs */
  readonly prices: { readonly title: string; readonly entries: readonly string[]; readonly none: string | null; readonly alert: string | null; readonly ok: string | null } | null
}

export interface PoLineLabels {
  readonly list: string
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly amount: string
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_8rem_9rem_9rem] md:items-start md:gap-4'

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3 md:block md:text-right">
      <span className="text-base text-ink-muted md:sr-only">{label}</span>
      <span className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</span>
    </p>
  )
}

export function PoLines({ lines, labels }: { lines: readonly PoLineView[]; labels: PoLineLabels }) {
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.description}</span>
        <span className="text-right">{labels.quantity}</span>
        <span className="text-right">{labels.unitPrice}</span>
        <span className="text-right">{labels.amount}</span>
      </div>
      <ol aria-label={labels.list} className="flex flex-col divide-y divide-line border-t border-line md:border-t-0">
        {lines.map((line) => (
          <li key={line.key} className="flex flex-col gap-2 py-3">
            <div className={`flex flex-col gap-1 ${GRID}`}>
              <div className="min-w-0">
                <p className="font-medium break-words text-ink">{line.title}</p>
                {line.sources.map((s) =>
                  s.href ? (
                    <Link key={s.label} href={s.href} className="block text-base break-words text-primary underline underline-offset-4 hover:no-underline md:text-sm">
                      {s.label}
                    </Link>
                  ) : (
                    <p key={s.label} className="text-base break-words text-ink md:text-sm">
                      {s.label}
                    </p>
                  ),
                )}
                {line.notes.map((note) => (
                  <p key={note} className="text-base text-ink-muted md:text-sm">
                    {note}
                  </p>
                ))}
              </div>
              <Figure label={labels.quantity} value={line.quantity} />
              <Figure label={labels.unitPrice} value={line.unitPrice} />
              <Figure label={labels.amount} value={line.amount} strong />
            </div>
            {line.prices ? (
              <div className="flex flex-col gap-1 border-l-2 border-line pl-3 md:ml-0">
                <p className="text-base text-ink-muted md:text-sm">{line.prices.title}</p>
                {line.prices.entries.length ? (
                  <ul className="flex flex-col">
                    {line.prices.entries.map((entry) => (
                      <li key={entry} className="tabular text-base text-ink md:text-sm">
                        {entry}
                      </li>
                    ))}
                  </ul>
                ) : line.prices.none ? (
                  <p className="text-base text-ink md:text-sm">{line.prices.none}</p>
                ) : null}
                {line.prices.alert ? (
                  <p className="inline-flex items-start gap-1.5 font-medium text-danger">
                    <TriangleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />
                    <span>{line.prices.alert}</span>
                  </p>
                ) : line.prices.ok ? (
                  <p className="inline-flex items-start gap-1.5 text-base text-ink md:text-sm">
                    <CircleCheck className="mt-[0.3em] size-4 shrink-0 text-primary" aria-hidden="true" />
                    <span>{line.prices.ok}</span>
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  )
}
