import Link from 'next/link'
import { STEP_BADGES, StatusBadge, type StepBadgeKey } from '../document/badges'
import { StateLine, type StateKind } from '../request-view/status'

// Rows of tasks waiting for a decision (inbox and home): what it is (a link to the decision page), who asked and for
// which department, the amount right-aligned in tabular digits, and where it stands — each state an icon with words,
// never colour alone; on the web inbox its SLA leads as the step badge of §9.10 (waiting, overdue, waiting for an
// answer). The title, who asked and the states are content, at the body's size (§9.9: 15 px on the web, 16 on phones);
// only the small label under the amount is smaller on the web. Rows separated by rules inside the page's card. Strings
// arrive translated and formatted.

export interface TaskRow {
  readonly id: string
  readonly href: string
  readonly title: string
  readonly meta?: string
  /** Formatted amount, e.g. 45,000.00 */
  readonly amount?: string
  /** What the amount is, e.g. "ยอดรวม VAT", and its unit for screen readers */
  readonly amountLabel?: string
  readonly amountUnit?: string
  readonly states: ReadonlyArray<{ readonly kind: StateKind; readonly text: string }>
  /** The task's SLA as a step badge (§9.10 งานอนุมัติ), translated */
  readonly badge?: { readonly key: StepBadgeKey; readonly label: string }
  /** Holding for someone, needs a code from the app … */
  readonly tags: readonly string[]
}

export function TaskList({ rows, label }: { rows: readonly TaskRow[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1.5 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col">
              <Link href={row.href} className="font-semibold break-words text-primary underline underline-offset-4 hover:no-underline">
                {row.title}
              </Link>
              {row.meta ? <span className="text-ink-muted">{row.meta}</span> : null}
            </div>
            {row.amount ? (
              <p className="flex shrink-0 flex-col items-end">
                <span className="money font-semibold text-ink">
                  {row.amount}
                  {row.amountUnit ? <span className="sr-only"> {row.amountUnit}</span> : null}
                </span>
                {row.amountLabel ? <span className="text-base text-ink-muted md:text-sm">{row.amountLabel}</span> : null}
              </p>
            ) : null}
          </div>
          {/* How long it has waited, when it is due, what it needs: content at the body's size (§9.9: 15 px on the web) */}
          {row.badge || row.states.length || row.tags.length ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              {row.badge ? <StatusBadge look={STEP_BADGES[row.badge.key]} label={row.badge.label} className="text-base md:text-sm" /> : null}
              {row.states.map((s) => (
                <StateLine key={s.text} kind={s.kind}>
                  {s.text}
                </StateLine>
              ))}
              {row.tags.map((tag) => (
                <span key={tag} className="rounded-sm border border-line px-1.5 text-ink">
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
