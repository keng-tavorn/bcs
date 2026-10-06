import { CircleCheck, TriangleAlert } from 'lucide-react'
import { LightLink } from '../light-link'

// The lines of a purchase order (FR-P2P-003, BR-CONS-04): each item with the request lines it orders (links), the
// quantity, unit price and amount before VAT right-aligned in tabular digits, what was received, and the prices paid
// for the same item on the last approved POs with a warning when the new price is too far above the last one (AC1) —
// an icon and words, never colour alone. On a screen from md up, where the list has room (the PO's column on a wide
// screen): columns; on a phone, and in a narrow column — the LIFF column (36rem) even on a wide screen, or the
// workspace's column on a laptop, where the menu and the aside take most of the page — each line stacks with the
// numbers next to their labels: never a table that scrolls sideways or squeezes the item to a sliver (§9.9, §9.4). The
// switch asks both the screen (md, as before) and the width of the list itself (a container query on its own element).
// Strings and numbers arrive translated and formatted.
// The links are light links (src/ui/light-link.tsx), not next/link: the LIFF decision page of a PO renders these lines
// too, and next/link's client code would weigh on its first JavaScript (§9.4: 200 KB gzip) even where no line links.

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

// Columns from md (as before) once the list is also at least 37rem wide: the three figures and the gaps take 29rem, so
// the item keeps 8rem or more — the columns the workspace showed before wherever they gave the item that much; in a
// narrower list the lines stack, and the LIFF column (36rem less its 1rem gutters) stays below 37rem at any screen
// width. The reasons and widths are in ../request-view/lines.tsx; Tailwind reads each class whole, so the variant is
// written out.
const GRID = 'md:@min-[37rem]:grid md:@min-[37rem]:grid-cols-[minmax(0,1fr)_8rem_9rem_9rem] md:@min-[37rem]:items-start md:@min-[37rem]:gap-4'

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className="flex items-baseline justify-between gap-3 md:@min-[37rem]:block md:@min-[37rem]:text-right">
      <span className="text-base text-ink-muted md:@min-[37rem]:sr-only">{label}</span>
      <span className={strong ? 'tabular font-semibold text-ink' : 'tabular text-ink'}>{value}</span>
    </p>
  )
}

export function PoLines({ lines, labels }: { lines: readonly PoLineView[]; labels: PoLineLabels }) {
  return (
    <div className="@container flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.description}</span>
        <span className="text-right">{labels.quantity}</span>
        <span className="text-right">{labels.unitPrice}</span>
        <span className="text-right">{labels.amount}</span>
      </div>
      <ol aria-label={labels.list} className="flex flex-col divide-y divide-line border-t border-line md:@min-[37rem]:border-t-0">
        {lines.map((line) => (
          <li key={line.key} className="flex flex-col gap-2 py-3">
            <div className={`flex flex-col gap-1 ${GRID}`}>
              <div className="min-w-0">
                <p className="font-medium break-words text-ink">{line.title}</p>
                {line.sources.map((s) =>
                  s.href ? (
                    <LightLink key={s.label} href={s.href} className="block text-base break-words text-primary underline underline-offset-4 hover:no-underline md:@min-[37rem]:text-sm">
                      {s.label}
                    </LightLink>
                  ) : (
                    <p key={s.label} className="text-base break-words text-ink md:@min-[37rem]:text-sm">
                      {s.label}
                    </p>
                  ),
                )}
                {line.notes.map((note) => (
                  <p key={note} className="text-ink-muted">
                    {note}
                  </p>
                ))}
              </div>
              <Figure label={labels.quantity} value={line.quantity} />
              <Figure label={labels.unitPrice} value={line.unitPrice} />
              <Figure label={labels.amount} value={line.amount} strong />
            </div>
            {/* The prices paid before, which the approver reads before deciding: content at the body's size (§9.9, 15 px on
                the web), under their 14 px label — a label shown only above prices, since "never bought" says it all
                by itself (§9.9: no label that adds nothing) */}
            {line.prices ? (
              <div className="flex flex-col gap-1 border-l-2 border-line pl-3">
                {line.prices.entries.length ? (
                  <>
                    <p className="text-base text-ink-muted md:@min-[37rem]:text-sm">{line.prices.title}</p>
                    <ul className="flex flex-col">
                      {line.prices.entries.map((entry) => (
                        <li key={entry} className="tabular text-ink">
                          {entry}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : line.prices.none ? (
                  <p className="text-ink">{line.prices.none}</p>
                ) : null}
                {line.prices.alert ? (
                  <p className="inline-flex items-start gap-1.5 font-medium text-danger">
                    <TriangleAlert className="mt-[0.3em] size-4 shrink-0" aria-hidden="true" />
                    <span>{line.prices.alert}</span>
                  </p>
                ) : line.prices.ok ? (
                  <p className="inline-flex items-start gap-1.5 text-ink">
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
