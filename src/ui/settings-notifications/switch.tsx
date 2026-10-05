import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '../cn'

// An on/off switch (§9.9): a native checkbox announced as a switch (role=switch: screen readers say on or off), drawn as
// a track with a knob, and the state in words beside it — never colour alone (NFR-A11Y-03). The whole row is the label,
// at least 44 px tall. The knob's move is the only motion and it shows the result of the tap (≤ 150 ms).

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role' | 'children'> {
  readonly id: string
  readonly label: ReactNode
  /** The current state in words ("เปิด" / "ปิด"), shown beside the track */
  readonly stateLabel: ReactNode
  readonly hint?: ReactNode
}

export function Switch({ id, label, stateLabel, hint, className, ...input }: SwitchProps) {
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3">
        <span className="relative inline-flex shrink-0">
          <input id={id} type="checkbox" role="switch" aria-describedby={hintId} className="peer sr-only" {...input} />
          <span
            aria-hidden="true"
            className="h-6 w-11 rounded-full border border-input bg-surface transition-colors duration-150 peer-checked:border-primary peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary peer-disabled:opacity-60"
          />
          <span
            aria-hidden="true"
            className="absolute top-1 left-1 size-4 rounded-full bg-ink-muted transition-transform duration-150 peer-checked:translate-x-5 peer-checked:bg-bg"
          />
        </span>
        <span className="font-medium text-ink">{label}</span>
        <span aria-hidden="true" className="text-ink-muted">
          {stateLabel}
        </span>
      </label>
      {hint ? (
        <p id={hintId} className="text-base text-ink-muted md:text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
