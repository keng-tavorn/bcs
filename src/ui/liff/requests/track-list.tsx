import type { RequestRow } from '../../request-view/request-list'
import { RequestStatus, StateLine } from '../../request-view/status'
import { LiffLink } from '../liff-link'

// "My requests" in LINE (§9.4 /liff/track, FR-INT-008 AC2: the requester and followers see the same status on every
// channel): the rows of the workspace's list (src/app/(workspace)/_tracking/rows.ts: the same status, the same "where it
// is now" with who it waits for and for how long, the same total), one column for a phone. Each title opens the
// request's LIFF page with its timeline. Status is an icon and words, never colour alone (NFR-A11Y-03); money is
// right-aligned with tabular digits (§9.9 principle 6). Server-rendered: no JavaScript of its own beyond the link.

export interface LiffTrackLabels {
  readonly list: string
  readonly status: string
  readonly now: string
  /** "ยอดรวม VAT (บาท)" */
  readonly amount: string
  readonly unit: string
}

const TITLE_LINK = 'inline-flex min-h-11 items-center font-semibold break-words text-primary underline underline-offset-4 hover:no-underline'

export function LiffTrackList({ rows, labels }: { readonly rows: readonly RequestRow[]; readonly labels: LiffTrackLabels }) {
  return (
    <ul aria-label={labels.list} className="flex flex-col divide-y divide-line border-y border-line">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1.5 py-3">
          <div className="flex min-w-0 flex-col">
            <LiffLink href={row.href} className={TITLE_LINK}>
              {row.title}
            </LiffLink>
            {row.meta.map((m) => (
              <span key={m} className="text-ink-muted">
                {m}
              </span>
            ))}
          </div>
          <p>
            <span className="sr-only">{labels.status}: </span>
            <RequestStatus status={row.status} label={row.statusLabel} />
          </p>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="break-words text-ink">
              <span className="sr-only">{labels.now}: </span>
              {row.now}
            </p>
            {row.nowStates.map((s) => (
              <StateLine key={s.text} kind={s.kind}>
                {s.text}
              </StateLine>
            ))}
          </div>
          <p className="flex items-baseline justify-between gap-4">
            <span className="text-ink-muted">{labels.amount}</span>
            <span className={row.amountIsMoney ? 'money font-semibold text-ink' : 'text-right text-ink-muted'}>
              {row.amount}
              {row.amountIsMoney ? <span className="sr-only"> {labels.unit}</span> : null}
            </span>
          </p>
        </li>
      ))}
    </ul>
  )
}
