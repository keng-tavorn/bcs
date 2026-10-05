import type { ReactNode } from 'react'
import { NoticeIcon } from '../notice'
import { describedBy } from './classes'

// The frame of one control on the LIFF request pages — a label (or, for a group of choices, a legend), the control, its
// hint and its error — as the workspace's form draws it (src/ui/request-form/controls.tsx Labelled, Choices and
// FieldError), apart from the field renderer (./field.tsx) so the requester's box and the cancel form of a request page
// carry this alone. An error is an icon and words (never colour alone, NFR-A11Y-03), tied to its control by id.

/** The error line under a control, tied to it by id (aria-describedby) */
export function LiffFieldError({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <p id={`${id}-error`} className="flex items-start gap-1.5 text-danger">
      <NoticeIcon tone="danger" />
      <span>{children}</span>
    </p>
  )
}

interface Framing {
  readonly id: string
  readonly label: ReactNode
  readonly requiredText?: string | undefined
  readonly hint?: ReactNode
  readonly error?: ReactNode
  readonly children: ReactNode
}

/** A label (or, for a group of choices, a legend), the control, its hint and its error */
export function LiffLabelled({ id, label, requiredText, hint, error, children, group = false }: Framing & { readonly group?: boolean }) {
  const caption = (
    <>
      {label}
      {requiredText ? <span className="ml-1.5 font-normal text-ink-muted">({requiredText})</span> : null}
    </>
  )
  const after = (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? <LiffFieldError id={id}>{error}</LiffFieldError> : null}
    </>
  )
  return group ? (
    <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={describedBy(id, Boolean(hint), Boolean(error))}>
      <legend className="mb-1 font-medium text-ink">{caption}</legend>
      <div className="flex flex-wrap gap-x-6 gap-y-1">{children}</div>
      {after}
    </fieldset>
  ) : (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {caption}
      </label>
      {children}
      {after}
    </div>
  )
}
