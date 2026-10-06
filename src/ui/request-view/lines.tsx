// The lines of a request. On a screen from md up, where the list has room — the request's column on a wide screen —
// columns (item, quantity, unit price, amount) with numbers right-aligned in tabular digits; on a phone, and in a narrow
// column — the LIFF column (36rem) even on a wide screen, or the workspace's column on a laptop, where the menu and the
// aside take most of the page — each line stacks, the numbers stay right-aligned next to their label: never a table that
// scrolls sideways or squeezes the item to a sliver (§9.9, §9.4). So the switch asks both the screen (md, as before) and
// the width of the list itself (a container query on its own element): the workspace's pages keep their layout, and the
// LIFF pages that render these lines get the phone's. Strings and numbers arrive translated and formatted.

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

// Columns from md (as before) once the list is also at least 37rem wide: the three figures and the gaps take 29rem, so
// the item keeps 8rem or more. That keeps the columns the workspace showed before wherever they gave the item that much
// (a tablet, a wide screen, a 1366 px laptop); where they overflowed the document's column or left the item less (from
// 1024 px, beside the menu and the aside, up to about 1350 px) the lines stack, as on a phone. The LIFF column (36rem
// less its 1rem gutters) stays below 37rem at any screen width. Tailwind reads each class whole, so the variant is written
// out (the same in ../purchase-order/po-lines.tsx). At laptop widths: tests/e2e/document-lines.ts.
const GRID = 'md:@min-[37rem]:grid md:@min-[37rem]:grid-cols-[minmax(0,1fr)_8rem_9rem_9rem] md:@min-[37rem]:items-baseline md:@min-[37rem]:gap-4'

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3 md:@min-[37rem]:block md:@min-[37rem]:text-right">
      <span className="text-base text-ink-muted md:@min-[37rem]:sr-only">{label}</span>
      <span className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</span>
    </p>
  )
}

export function LineList({ lines, labels }: { lines: readonly LineView[]; labels: LineLabels }) {
  return (
    <div className="@container flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.description}</span>
        <span className="text-right">{labels.quantity}</span>
        <span className="text-right">{labels.unitPrice}</span>
        <span className="text-right">{labels.amount}</span>
      </div>
      <ol className="flex flex-col divide-y divide-line border-t border-line md:@min-[37rem]:border-t-0">
        {lines.map((line) => (
          <li key={line.key} className={`flex flex-col gap-1 py-3 ${GRID}`}>
            <div className="min-w-0">
              <p className="font-medium break-words text-ink">{line.description}</p>
              {line.notes.map((note) => (
                <p key={note} className="text-ink-muted">
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
