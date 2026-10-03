// The lines of a request. Wide screens: columns (item, quantity, unit price, amount) with numbers right-aligned in
// tabular digits; phones: each line stacks, the numbers stay right-aligned next to their label — never a table that
// scrolls sideways (§9.9). Strings and numbers arrive translated and formatted.

export interface LineView {
  readonly key: string
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly amount: string
  /** Short facts under the item: no VAT, the day the service ends */
  readonly notes: readonly string[]
}

export interface LineLabels {
  readonly description: string
  readonly quantity: string
  readonly unitPrice: string
  readonly amount: string
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_8rem_9rem_9rem] md:items-baseline md:gap-4'

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3 md:block md:text-right">
      <span className="text-base text-ink-muted md:sr-only">{label}</span>
      <span className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</span>
    </p>
  )
}

export function LineList({ lines, labels }: { lines: readonly LineView[]; labels: LineLabels }) {
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.description}</span>
        <span className="text-right">{labels.quantity}</span>
        <span className="text-right">{labels.unitPrice}</span>
        <span className="text-right">{labels.amount}</span>
      </div>
      <ol className="flex flex-col divide-y divide-line border-t border-line md:border-t-0">
        {lines.map((line) => (
          <li key={line.key} className={`flex flex-col gap-1 py-3 ${GRID}`}>
            <div className="min-w-0">
              <p className="font-medium break-words text-ink">{line.description}</p>
              {line.notes.map((note) => (
                <p key={note} className="text-base text-ink-muted md:text-sm">
                  {note}
                </p>
              ))}
            </div>
            <Figure label={labels.quantity} value={line.quantity} />
            <Figure label={labels.unitPrice} value={line.unitPrice} />
            <Figure label={labels.amount} value={line.amount} strong />
          </li>
        ))}
      </ol>
    </div>
  )
}
