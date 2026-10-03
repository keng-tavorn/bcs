import { CircleAlert } from 'lucide-react'
import type { ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '../cn'

// A labelled select with an optional hint and error, like Field (src/ui/form/field.tsx): the error is announced with
// the control and shown with an icon and words, never colour alone (NFR-A11Y-03). Options arrive translated.

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly id: string
  readonly label: ReactNode
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  /** A first, empty option that asks to choose (its label arrives translated) */
  readonly placeholder?: string
  readonly hint?: ReactNode
  readonly error?: ReactNode
}

export function SelectField({ id, label, options, placeholder, hint, error, className, ...select }: SelectFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={cn('h-11 w-full min-w-0 rounded-md border border-input bg-bg px-3 text-base text-ink aria-[invalid=true]:border-danger', className)}
        {...select}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={hintId} className="text-base text-ink-muted md:text-sm">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}
