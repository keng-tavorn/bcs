import { Check, CircleDot, Clock, X } from 'lucide-react'

// Approval timeline — the one signature element of the UI (spec §9.9): every step reads like a stamp with
// name, position, time, channel and the DOA rule used; the current step stands out. Status is always shown
// with an icon and words, never colour alone (NFR-A11Y-03). Strings arrive already translated and formatted.

export type TimelineState = 'done' | 'current' | 'upcoming'
export type TimelineOutcome = 'approved' | 'rejected' | 'neutral'

export interface TimelineItem {
  readonly id: string
  readonly title: string
  readonly actor: string
  readonly role?: string
  readonly when?: string
  readonly channel?: string
  readonly doaRef?: string
  readonly onBehalfOf?: string
  readonly waiting?: string
  readonly state: TimelineState
  readonly outcome?: TimelineOutcome
  readonly statusLabel: string
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
  if (outcome === 'rejected') {
    return (
      <span className={`${base} border-danger text-danger`} aria-hidden="true">
        <X className="size-4" />
      </span>
    )
  }
  return (
    <span className={`${base} border-primary text-primary`} aria-hidden="true">
      <Check className="size-4" />
    </span>
  )
}

export function Timeline({ items, label }: { items: readonly TimelineItem[]; label: string }) {
  return (
    <ol aria-label={label} className="relative flex flex-col">
      {items.map((item, index) => {
        const last = index === items.length - 1
        return (
          <li key={item.id} className="relative flex gap-3 pb-5" aria-current={item.state === 'current' ? 'step' : undefined}>
            {!last && <span aria-hidden="true" className="absolute left-3.5 top-7 h-[calc(100%-1.75rem)] w-px bg-line" />}
            <Marker state={item.state} outcome={item.outcome} />
            <div className={`min-w-0 flex-1 ${item.state === 'current' ? 'rounded-md border border-warn/40 bg-surface p-3' : 'pt-0.5'}`}>
              <p className="font-semibold text-ink">
                {item.title}
                <span className="sr-only"> — {item.statusLabel}</span>
              </p>
              <p className="text-ink">
                {item.actor}
                {item.role ? <span className="text-ink-muted"> · {item.role}</span> : null}
              </p>
              {item.onBehalfOf ? <p className="text-ink-muted">{item.onBehalfOf}</p> : null}
              {item.when || item.channel ? (
                <p className="tabular text-ink-muted">{[item.when, item.channel].filter(Boolean).join(' · ')}</p>
              ) : null}
              {item.waiting ? <p className="font-medium text-warn">{item.waiting}</p> : null}
              {item.doaRef ? (
                <p className="mt-1.5">
                  <span className="inline-block rounded-sm border-2 border-primary px-1.5 py-0.5 text-sm font-semibold text-primary">
                    {item.doaRef}
                  </span>
                </p>
              ) : null}
              <p className="mt-1 text-sm text-ink-muted" aria-hidden="true">
                {item.statusLabel}
              </p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
