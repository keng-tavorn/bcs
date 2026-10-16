import { LiffLink } from '../liff-link'
import { LiffWebLink } from '../web-link'

// The lists the role buttons of the rich menu open (FR-LINE-303 AC3 AC4 · S17-04 · §9.4): /liff/gr, the POs a receiver
// may receive, each opening /liff/gr/[poId]; /liff/procurement, purchasing's work in numbers with links to the web.
// Server components in one column for a phone, rows separated by rules (no cards), every link at least 44 px high; no
// prices on either (BR-NOTI-01's care for what LINE shows).

const LIST = 'flex flex-col divide-y divide-line border-y border-line'
const ROW_LINK = 'inline-flex min-h-11 items-center self-start font-semibold break-words text-primary underline underline-offset-4 hover:no-underline'
const PLAIN_LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export interface LiffReceivableRow {
  readonly id: string
  readonly href: string
  readonly title: string
  /** Where it is delivered, the requests, when it was sent, what is still to come */
  readonly lines: readonly string[]
}

export function LiffReceivableList({ rows, label }: { readonly rows: readonly LiffReceivableRow[]; readonly label: string }) {
  return (
    <ul aria-label={label} className={LIST}>
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1 py-3">
          <LiffLink href={row.href} className={ROW_LINK}>
            {row.title}
          </LiffLink>
          {row.lines.map((line) => (
            <p key={line} className="break-words text-ink-muted">
              {line}
            </p>
          ))}
        </li>
      ))}
    </ul>
  )
}

/** A link to the web, opened outside LINE, that says so to a screen reader */
export function LiffWebAnchor({ href, text, webHint }: { readonly href: string; readonly text: string; readonly webHint: string }) {
  return (
    <LiffWebLink href={href} className={PLAIN_LINK}>
      {text}
      <span className="sr-only"> ({webHint})</span>
    </LiffWebLink>
  )
}

export interface LiffCountRow {
  readonly key: string
  readonly label: string
  readonly count: string
  readonly href: string
}

/** Numbers by status, each a link to that list on the web */
export function LiffCountList({ rows, label, webHint }: { readonly rows: readonly LiffCountRow[]; readonly label: string; readonly webHint: string }) {
  return (
    <ul aria-label={label} className={LIST}>
      {rows.map((row) => (
        <li key={row.key} className="flex items-center justify-between gap-4 py-1">
          <LiffWebLink href={row.href} className={PLAIN_LINK}>
            {row.label}
            <span className="sr-only"> ({webHint})</span>
          </LiffWebLink>
          <span className="shrink-0 font-semibold text-ink tabular-nums">{row.count}</span>
        </li>
      ))}
    </ul>
  )
}
