import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import { cn } from '../cn'
import { NoticeIcon } from '../notice'

// The fields of the LIFF forms (/liff/gr/[poId], /liff/delegation): the workspace's src/ui/form/field.tsx look and
// rules — a visible label, a hint and an error tied to the input (aria-describedby, aria-invalid), the error as an icon
// and words, never colour alone (NFR-A11Y-03) — without the icon library and the client code that file brings into a
// LIFF page's first JavaScript (§9.4: 200 KB gzip). 16 px text and 44 px high inputs (§9.4).

const INPUT_CLASS = 'w-full rounded-md border border-input bg-bg px-3 text-base text-ink placeholder:text-ink-muted aria-[invalid=true]:border-danger'

/** The ids an input is described by: its hint and its error */
export function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined
}

/** The error line under a field: an icon and the words */
export function FieldError({ id, text }: { readonly id: string; readonly text?: string | null }) {
  if (!text) return null
  return (
    <p id={id} className="flex items-start gap-1.5 text-danger">
      <NoticeIcon tone="danger" className="text-danger" />
      <span>{text}</span>
    </p>
  )
}

export interface LiffFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly id: string
  readonly label: ReactNode
  readonly hint?: string
  readonly error?: string | null
}

export function LiffField({ id, label, hint, error, className, ...input }: LiffFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} className={cn(INPUT_CLASS, 'h-11', className)} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} text={error} />
    </div>
  )
}

export interface LiffTextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly id: string
  readonly label: ReactNode
  readonly hint?: string
}

export function LiffTextArea({ id, label, hint, className, ...area }: LiffTextAreaProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="font-medium text-ink">
        {label}
      </label>
      <textarea id={id} rows={3} aria-describedby={hint ? `${id}-hint` : undefined} className={cn(INPUT_CLASS, 'min-h-24 py-2 leading-relaxed', className)} {...area} />
      {hint ? (
        <p id={`${id}-hint`} className="text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** A radio button with its words, 44 px high */
export function LiffRadio({ name, checked, onChange, label, value }: { readonly name: string; readonly checked: boolean; readonly onChange: () => void; readonly label: ReactNode; readonly value?: string }) {
  return (
    <label className="flex min-h-11 items-center gap-3">
      <input type="radio" name={name} value={value} checked={checked} onChange={onChange} className="size-5 shrink-0 accent-[var(--primary)]" />
      <span>{label}</span>
    </label>
  )
}
