import type { ReactNode } from 'react'
import { NoticeIcon } from '../notice'

// The fields of the LIFF decision forms (FR-DOA-004 AC1, §9.4, §9.9): a reason or a question, and the tick that says
// what the member agrees to. They look and read like the workspace's TextArea and ConfirmBox
// (src/ui/request-view/text-area.tsx) — a label, a hint and an error announced with the field (aria-describedby), the
// error with an icon and words, never colour alone (NFR-A11Y-03) — without the icon library those bring, which a LIFF
// page would carry in its first JavaScript (§9.4: 200 KB gzip with the LINE SDK). 16 px text, 44 px targets.

/** A field's error: an icon and words, announced with the field it belongs to */
export function FieldError({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p id={id} className="flex items-start gap-1.5 text-danger">
      <NoticeIcon tone="danger" />
      <span>{children}</span>
    </p>
  )
}

export interface LiffTextAreaProps {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly hint?: string
  readonly error?: string | undefined
  readonly value: string
  readonly onChange: (value: string) => void
  readonly maxLength: number
}

export function LiffTextArea({ id, name, label, hint, error, value, onChange, maxLength }: LiffTextAreaProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
      <textarea
        id={id}
        name={name}
        rows={3}
        value={value}
        maxLength={maxLength}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="w-full rounded-md border border-input bg-bg px-3 py-2 text-base text-ink aria-[invalid=true]:border-danger"
      />
      {error && errorId ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  )
}

export interface LiffTickProps {
  readonly id: string
  readonly label: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly error?: string | undefined
}

/** A required tick that says what the member agrees to (an irreversible decision, §9.9) */
export function LiffTick({ id, label, checked, onChange, error }: LiffTickProps) {
  const errorId = `${id}-error`
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex min-h-11 items-start gap-3 py-1">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="mt-1 size-5 shrink-0"
        />
        <span>{label}</span>
      </label>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  )
}
