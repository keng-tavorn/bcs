import Link from 'next/link'
import { PO_BADGES, StatusBadge, URGENCY_BADGES } from '../document/badges'
import { StateLine, type StateKind } from '../request-view/status'

// Rows of purchase orders (spec §9.1 /procurement/pos): the PO (a link) with its supplier, site and source requests, its
// status as the badge of §9.10 (icon and words, never colour alone), an urgent PO's urgency badge, whom it waits for
// now and for how long, and the total with VAT right-aligned in tabular digits. Wide screens line the parts up in
// columns under one header row; phones stack them — never a table that scrolls sideways (§9.9). Strings arrive translated and formatted.

export interface PoRow {
  readonly id: string
  readonly href: string
  readonly title: string
  readonly meta: readonly string[]
  /** The urgency badge's word when the PO is urgent */
  readonly urgent: string | null
  readonly status: string
  readonly statusLabel: string
  readonly now: string
  readonly nowStates: ReadonlyArray<{ readonly kind: StateKind; readonly text: string }>
  readonly amount: string
}

export interface PoListLabels {
  readonly list: string
  readonly po: string
  readonly status: string
  readonly now: string
  readonly amount: string
  readonly unit: string
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_9rem] md:items-start md:gap-4'

export function PoList({ rows, labels }: { rows: readonly PoRow[]; labels: PoListLabels }) {
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.po}</span>
        <span>{labels.status}</span>
        <span>{labels.now}</span>
        <span className="text-right">{labels.amount}</span>
      </div>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line">
        {rows.map((row) => (
          <li key={row.id} className={`flex flex-col gap-1.5 py-3 ${GRID}`}>
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                {row.title}
              </Link>
              {row.meta.map((m) => (
                <span key={m} className="text-base break-words text-ink-muted md:text-sm">
                  {m}
                </span>
              ))}
              {row.urgent ? (
                <span className="mt-0.5 flex flex-wrap gap-2">
                  <StatusBadge look={URGENCY_BADGES.URGENT} label={row.urgent} className="text-base md:text-sm" />
                </span>
              ) : null}
            </div>
            <div>
              <span className="sr-only">{labels.status}: </span>
              <StatusBadge look={PO_BADGES[row.status]} label={row.statusLabel} className="text-base md:text-sm" />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="sr-only">{labels.now}: </span>
              <span className="break-words text-ink">{row.now}</span>
              {row.nowStates.map((s) => (
                <StateLine key={s.text} kind={s.kind} className="text-base md:text-sm">
                  {s.text}
                </StateLine>
              ))}
            </div>
            <div className="flex flex-col items-end">
              <p className="money font-semibold text-ink">
                <span className="sr-only">{labels.amount}: </span>
                {row.amount}
                <span className="sr-only"> {labels.unit}</span>
              </p>
              <span className="text-base text-ink-muted md:hidden" aria-hidden="true">
                {labels.amount}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
