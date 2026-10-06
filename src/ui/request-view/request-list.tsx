import Link from 'next/link'
import { RequestStatus, StateLine, type StateKind } from './status'

// Rows of "my requests" (FR-INT-008): the request (a link), its status, where it is now and for how long, and the total
// right-aligned in tabular digits. Wide screens line the parts up in columns under one header row; phones stack them —
// never a table that scrolls sideways (§9.9) — and name the amount under it. Strings arrive translated and formatted.

export interface RequestRow {
  readonly id: string
  readonly href: string
  readonly title: string
  readonly meta: readonly string[]
  readonly status: string
  readonly statusLabel: string
  readonly now: string
  readonly nowStates: ReadonlyArray<{ readonly kind: StateKind; readonly text: string }>
  /** Formatted total, or a short text when there is none yet */
  readonly amount: string
  readonly amountIsMoney: boolean
}

export interface RequestListLabels {
  readonly list: string
  readonly request: string
  readonly status: string
  readonly now: string
  readonly amount: string
  readonly unit: string
}

const GRID = 'md:grid md:grid-cols-[minmax(0,1.5fr)_minmax(0,0.9fr)_minmax(0,1.5fr)_9rem] md:items-start md:gap-4'

export function RequestList({ rows, labels }: { rows: readonly RequestRow[]; labels: RequestListLabels }) {
  return (
    <div className="flex flex-col">
      <div className={`hidden border-b border-line pb-2 text-sm text-ink-muted ${GRID}`} aria-hidden="true">
        <span>{labels.request}</span>
        <span>{labels.status}</span>
        <span>{labels.now}</span>
        <span className="text-right">{labels.amount}</span>
      </div>
      <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-b border-line">
        {rows.map((row) => (
          <li key={row.id} className={`flex flex-col gap-1.5 py-3 ${GRID}`}>
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                {row.title}
              </Link>
              {row.meta.map((m) => (
                <span key={m} className="text-base text-ink-muted md:text-sm">
                  {m}
                </span>
              ))}
            </div>
            <div>
              <span className="sr-only">{labels.status}: </span>
              <RequestStatus status={row.status} label={row.statusLabel} />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="sr-only">{labels.now}: </span>
              <span className="break-words text-ink">{row.now}</span>
              {/* How long it has waited and when it is due: content at the body's size (§9.9: 15 px on the web) */}
              {row.nowStates.map((s) => (
                <StateLine key={s.text} kind={s.kind}>
                  {s.text}
                </StateLine>
              ))}
            </div>
            <div className="flex flex-col items-end">
              <p className={row.amountIsMoney ? 'money font-semibold text-ink' : 'text-right text-ink-muted'}>
                <span className="sr-only">{labels.amount}: </span>
                {row.amount}
                {row.amountIsMoney ? <span className="sr-only"> {labels.unit}</span> : null}
              </p>
              {/* Phones have no header row: the amount says what it is (screen readers heard it above) */}
              {row.amountIsMoney ? (
                <span className="text-base text-ink-muted md:hidden" aria-hidden="true">
                  {labels.amount}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
