import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn'

// Building blocks of the request form: a label with an optional "required" word, a hint and an error, all tied to the
// control (aria-describedby). Errors show an icon and words, never colour alone (NFR-A11Y-03). Mobile text 16 px, web
// 15 px with 14 px hints (§9.9).

export const inputClass =
  'h-11 w-full min-w-0 rounded-md border border-input bg-bg px-3 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-60'
export const textareaClass =
  'min-h-28 w-full min-w-0 rounded-md border border-input bg-bg px-3 py-2 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger'
/** A checkbox or radio button: 20 px, never squeezed; src/app/globals.css draws it from the tokens */
export const checkboxClass = 'size-5 shrink-0'

export const describedBy = (id: string, hint: boolean, error: boolean) => [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined

export function Hint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={`${id}-hint`} className="text-base text-ink-muted md:text-sm">
      {children}
    </p>
  )
}

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

/** A label, the control, its hint and its error */
export function Labelled({
  id,
  label,
  requiredText,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: ReactNode
  /** The word shown after the label of a required field ("จำเป็น") */
  requiredText?: string
  hint?: ReactNode
  error?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <label htmlFor={id} className="font-medium text-ink">
        {label}
        {requiredText ? <span className="ml-1.5 font-normal text-ink-muted">({requiredText})</span> : null}
      </label>
      {children}
      {hint ? <Hint id={id}>{hint}</Hint> : null}
      {error ? <FieldError id={id}>{error}</FieldError> : null}
    </div>
  )
}

/** A group of radio buttons or tick boxes with its question as the legend */
export function Choices({
  id,
  legend,
  requiredText,
  hint,
  error,
  children,
}: {
  id: string
  legend: ReactNode
  requiredText?: string
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={describedBy(id, Boolean(hint), Boolean(error))}>
      <legend className="mb-1 font-medium text-ink">
        {legend}
        {requiredText ? <span className="ml-1.5 font-normal text-ink-muted">({requiredText})</span> : null}
      </legend>
      <div className="flex flex-wrap gap-x-6 gap-y-1">{children}</div>
      {hint ? <Hint id={id}>{hint}</Hint> : null}
      {error ? <FieldError id={id}>{error}</FieldError> : null}
    </fieldset>
  )
}
