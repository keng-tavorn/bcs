import { CircleAlert } from 'lucide-react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '../cn'

// A labelled input with an optional hint and error. The error is announced with the input (aria-describedby)
// and shown with an icon and words, never colour alone (NFR-A11Y-03).

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly id: string
  readonly label: ReactNode
  readonly hint?: ReactNode
  readonly error?: ReactNode
}

export function Field({ id, label, hint, error, className, ...input }: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={cn(
          'h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger',
          className,
        )}
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-base md:text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-base md:text-sm text-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}
