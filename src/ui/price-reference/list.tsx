import type { ReactNode } from 'react'
import { NO_FIGURE, type PriceAlert, type PriceLineView, type PriceQuotesView, type PriceReferenceLabels } from './view'

// The price reference as a list (S6-11 · FR-DOA-101 AC2): each line of the request stacked — its item and, when it is
// far from the median, the badge; then label and figure on one row, the figures right-aligned in tabular digits (§9.9
// principle 6); how many prices the figures read, "few prices" in words (BR-PRC-02) and the agreed price. The LIFF task
// page shows it as it is, and the workspace panel (./panel.tsx) on a phone or a narrow column. Plain elements only, no
// shadcn/ui and no client code (ADR-052, §9.4): the page passes the badge of its own kind (LiffStatusBadge or the
// workspace's StatusBadge). Strings and numbers arrive translated and formatted.

function Row({ label, value, unit, strong }: { label: string; value: string; unit: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={strong ? 'money font-semibold text-ink' : 'money text-ink'}>
        {value}
        {unit ? <span className="sr-only"> {unit}</span> : null}
      </dd>
    </div>
  )
}

export function PriceLineList({ lines, labels, badge }: { lines: readonly PriceLineView[]; labels: PriceReferenceLabels; badge: (alert: { kind: PriceAlert; label: string }) => ReactNode }) {
  return (
    <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-t border-line">
      {lines.map((line) => (
        <li key={line.key} className="flex flex-col gap-2 py-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 font-medium break-words text-ink">{line.title}</p>
            {line.alert ? badge(line.alert) : null}
          </div>
          <dl className="flex flex-col">
            <Row label={labels.unitPrice} value={line.unitPrice} unit={labels.unit} strong />
            <Row label={labels.median} value={line.median} unit={line.median === NO_FIGURE ? '' : labels.unit} />
            <Row label={labels.min} value={line.min} unit={line.min === NO_FIGURE ? '' : labels.unit} />
            <Row label={labels.max} value={line.max} unit={line.max === NO_FIGURE ? '' : labels.unit} />
            <Row label={labels.last} value={line.last} unit={line.last === NO_FIGURE ? '' : labels.unit} />
            <Row label={labels.deviation} value={line.deviation} unit="" />
          </dl>
          <PriceLineNotes line={line} />
        </li>
      ))}
    </ul>
  )
}

/** Under a line: how many prices, "few prices" and the agreed price (also under the item in the workspace table) */
export function PriceLineNotes({ line }: { line: PriceLineView }) {
  return (
    <div className="flex flex-col">
      <p className="text-ink-muted">{line.samples}</p>
      {line.few ? <p className="text-ink">{line.few}</p> : null}
      {line.agreement ? <p className="break-words text-ink">{line.agreement}</p> : null}
    </div>
  )
}

/** The request's quotations before VAT (BR-PRC-04): how many, lowest, highest, the chosen one, and why when not the lowest */
export function PriceQuotes({ quotes, unit }: { quotes: PriceQuotesView; unit: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium text-ink">{quotes.title}</p>
      <dl className="flex w-full max-w-[var(--amounts-max-width,28rem)] flex-col">
        {quotes.rows.map((row, i) => (
          // The first row is a count, the others money
          <Row key={row.label} label={row.label} value={row.value} unit={i === 0 || row.value === NO_FIGURE ? '' : unit} />
        ))}
      </dl>
      {quotes.note ? <p className="break-words text-ink">{quotes.note}</p> : null}
    </div>
  )
}
