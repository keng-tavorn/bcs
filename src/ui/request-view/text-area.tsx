import { CircleAlert } from 'lucide-react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { cn } from '../cn'

// A labelled multi-line field (reasons, questions, answers) with an optional hint and error, announced with the field
// (aria-describedby) and shown with an icon and words, never colour alone (NFR-A11Y-03).

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly id: string
  readonly label: ReactNode
  readonly hint?: ReactNode
  readonly error?: ReactNode
}

export function TextArea({ id, label, hint, error, className, rows = 3, ...rest }: TextAreaProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-base text-ink-muted md:text-sm">
          {hint}
        </p>
      ) : null}
      <textarea
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        className={cn('w-full rounded-md border border-input bg-bg px-3 py-2 text-base text-ink aria-[invalid=true]:border-danger', className)}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

/** A required tick box that says what the member agrees to (irreversible actions, §9.9) */
export function ConfirmBox({ id, label, checked, onChange, error }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void; error?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex min-h-11 items-center gap-3">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="size-5 shrink-0 accent-[var(--primary)]"
        />
        <span>{label}</span>
      </label>
      {error ? (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-base text-danger md:text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}
