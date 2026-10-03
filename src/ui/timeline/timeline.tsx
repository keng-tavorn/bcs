import { Ban, Check, CircleDot, Clock, Undo2, X } from 'lucide-react'
import { cn } from '../cn'

// Approval timeline — the one signature element of the UI (spec §9.9): every decision reads like a stamp with name,
// position, time, channel and the DOA rule used (a link to that version, FR-DOA-005 AC2); the current step stands out
// with who it waits for and for how long (FR-INT-008 AC1). Status is always shown with an icon and words, never colour
// alone (NFR-A11Y-03). Strings arrive already translated and formatted.

export type TimelineState = 'done' | 'current' | 'upcoming'
export type TimelineOutcome = 'approved' | 'rejected' | 'returned' | 'cancelled' | 'neutral'

export interface TimelineItem {
  readonly id: string
  readonly title: string
  readonly actor: string
  readonly role?: string
  readonly when?: string
  readonly channel?: string
  readonly doaRef?: string
  /** The DOA version the decision cites; the reference becomes a link to it */
  readonly doaHref?: string
  readonly onBehalfOf?: string
  readonly waiting?: string
  /** When the current step is due, or since when it is overdue */
  readonly due?: string
  readonly overdue?: boolean
  /** A reason, a question or an answer, quoted as written */
  readonly note?: string
  readonly noteLabel?: string
  readonly state: TimelineState
  readonly outcome?: TimelineOutcome
  readonly statusLabel: string
  /** Draw the step as a stamp: a decision under the DOA */
  readonly stamp?: boolean
}

const OUTCOME_LOOK: Record<Exclude<TimelineOutcome, 'neutral'>, { Icon: typeof Check; marker: string; stamp: string; title: string }> = {
  approved: { Icon: Check, marker: 'border-primary text-primary', stamp: 'border-primary', title: 'text-primary' },
  rejected: { Icon: X, marker: 'border-danger text-danger', stamp: 'border-danger', title: 'text-danger' },
  returned: { Icon: Undo2, marker: 'border-warn text-warn', stamp: 'border-warn', title: 'text-warn' },
  cancelled: { Icon: Ban, marker: 'border-ink-muted text-ink-muted', stamp: 'border-ink-muted', title: 'text-ink' },
}

function Marker({ state, outcome }: { state: TimelineState; outcome: TimelineOutcome | undefined }) {
  const base = 'flex size-7 shrink-0 items-center justify-center rounded-full border-2 bg-bg'
  if (state === 'current') {
    return (
      <span className={`${base} border-warn text-warn`} aria-hidden="true">
        <Clock className="size-4" />
      </span>
    )
  }
  if (state === 'upcoming') {
    return (
      <span className={`${base} border-line text-ink-muted`} aria-hidden="true">
        <CircleDot className="size-4" />
      </span>
    )
  }
  const look = outcome && outcome !== 'neutral' ? OUTCOME_LOOK[outcome] : OUTCOME_LOOK.approved
  return (
    <span className={`${base} ${look.marker}`} aria-hidden="true">
      <look.Icon className="size-4" />
    </span>
  )
}

function DoaRef({ item }: { item: TimelineItem }) {
  if (!item.doaRef) return null
  const label = <span className="inline-block rounded-sm border-2 border-primary px-1.5 py-0.5 text-base font-semibold text-primary md:text-sm">{item.doaRef}</span>
  return <p className="mt-1.5">{item.doaHref ? <a href={item.doaHref} className="inline-block underline-offset-4 hover:underline">{label}</a> : label}</p>
}

export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  return (
    <ol aria-label={label} className="relative flex flex-col">
      {items.map((item, index) => {
        const last = index === items.length - 1
        const look = item.outcome && item.outcome !== 'neutral' ? OUTCOME_LOOK[item.outcome] : null
        const box =
          item.state === 'current'
            ? 'rounded-md border border-warn/40 bg-surface p-3'
            : item.stamp && look
              ? cn('rounded-sm border-2 bg-bg px-3 py-2', look.stamp)
              : 'pt-0.5'
        return (
          <li key={item.id} className="relative flex gap-3 pb-5" aria-current={item.state === 'current' ? 'step' : undefined}>
            {!last && <span aria-hidden="true" className="absolute top-7 left-3.5 h-[calc(100%-1.75rem)] w-px bg-line" />}
            <Marker state={item.state} outcome={item.outcome} />
            <div className={cn('min-w-0 flex-1', box)}>
              <p className={cn('font-semibold', item.stamp && look ? look.title : 'text-ink', item.state === 'upcoming' && 'text-ink-muted')}>
                {item.title}
                <span className="sr-only"> — {item.statusLabel}</span>
              </p>
              {item.actor || item.role ? (
                <p className="text-ink">
                  {item.actor}
                  {item.role ? <span className="text-ink-muted">{item.actor ? ' · ' : ''}{item.role}</span> : null}
                </p>
              ) : null}
              {item.onBehalfOf ? <p className="text-ink-muted">{item.onBehalfOf}</p> : null}
              {item.when || item.channel ? <p className="tabular text-ink-muted">{[item.when, item.channel].filter(Boolean).join(' · ')}</p> : null}
              {item.waiting ? <p className="font-medium text-warn">{item.waiting}</p> : null}
              {item.due ? <p className={cn('tabular', item.overdue ? 'font-medium text-danger' : 'text-ink-muted')}>{item.due}</p> : null}
              {item.note ? (
                <blockquote className="mt-1.5 border-l-2 border-line pl-3 text-ink">
                  {item.noteLabel ? <span className="block text-base text-ink-muted md:text-sm">{item.noteLabel}</span> : null}
                  <span className="break-words whitespace-pre-line">{item.note}</span>
                </blockquote>
              ) : null}
              <DoaRef item={item} />
              <p className="mt-1 text-base text-ink-muted md:text-sm" aria-hidden="true">
                {item.statusLabel}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
