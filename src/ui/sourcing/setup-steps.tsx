import { CircleCheck, CircleDot } from 'lucide-react'
import Link from 'next/link'
import { cn } from '../cn'

// The steps of an RFx being set up (S10-12 · "Stepper (Tabs แนวตั้ง)"): a numbered list of real steps, the current one
// marked (aria-current="step", a heavier word and a bar), a finished one with a tick and its word; each step a link
// while it can be opened. A column on a computer's screen, a list that wraps on a phone. No colour alone (§9.9).

export interface SetupStepView {
  readonly key: string
  readonly label: string
  /** null: not open yet (shown, not a link) */
  readonly href: string | null
  readonly done: boolean
}

export function SetupStepNav({ steps, current, label, doneLabel }: { steps: readonly SetupStepView[]; current: string; label: string; doneLabel: string }) {
  return (
    <nav aria-label={label}>
      <ol className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line pb-2 lg:flex-col lg:flex-nowrap lg:gap-1 lg:border-b-0 lg:border-l lg:pb-0">
        {steps.map((s, i) => {
          const active = s.key === current
          const body = (
            <span className="inline-flex items-center gap-2">
              {s.done ? <CircleCheck className="size-4 shrink-0 text-primary" aria-hidden="true" /> : <CircleDot className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />}
              <span>{`${i + 1}. ${s.label}`}</span>
              {s.done ? <span className="sr-only">{` (${doneLabel})`}</span> : null}
            </span>
          )
          return (
            <li
              key={s.key}
              aria-current={active ? 'step' : undefined}
              className={cn('flex min-h-11 items-center lg:-ml-px lg:min-h-10 lg:border-l-2 lg:pl-3', active ? 'border-b-2 border-primary font-semibold text-ink lg:border-b-0' : 'border-transparent text-ink-muted')}
            >
              {s.href && !active ? (
                <Link href={s.href} className="underline-offset-4 hover:underline">
                  {body}
                </Link>
              ) : (
                body
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
