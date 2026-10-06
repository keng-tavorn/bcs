'use client'

import { cn } from './cn'
import { NoticeIcon } from './notice'

// The transaction PIN field of LIFF pages (FR-AUTH-005, FR-LINE-003 AC2): the decision forms of /liff/tasks/[id] use it.
// A password field, so the digits are masked and never read aloud, with the phone's numeric keypad (inputmode=numeric);
// it keeps the ASCII digits 0–9 only, as the PIN rule does (src/core/pin), and at most `length` of them (PIN_LENGTH,
// which the page gets from the server, e.g. liffFacts().pinLength), as each change comes in. The field has no maxLength
// on purpose: the browser would cut a pasted "582 931" or "58-29-31" to its first `length` characters before the digits
// are picked out, and in a masked field nobody would see that a digit went missing. It never submits on its own when the
// last digit is typed: the person presses the button that says what happens. The PIN is no password of the account:
// autocomplete=one-time-code keeps browsers from filling in the account password or offering to save the PIN, with the
// opt-outs of 1Password (data-1p-ignore), LastPass (data-lpignore), Bitwarden (data-bwignore) and Dashlane
// (data-form-type=other), as the PIN fields of the web do (src/ui/tasks/pin-field.tsx, /settings/pin). The value lives in
// the page's state only: never in a URL, storage or a log. Disabled while a decision is sent, it takes the look of a
// disabled LIFF button (./button.tsx): --ink-muted on --surface inside --line, 6.7:1; faded instead, it fell to about
// 4.1:1, under the 4.5:1 of §9.9.

/** The digits 0–9 of what was typed or pasted, at most `length` of them */
export function pinDigits(raw: string, length: number): string {
  return raw.replace(/[^0-9]/g, '').slice(0, Math.max(0, length))
}

export interface PinInputProps {
  readonly id: string
  readonly label: string
  /** How many digits a PIN has (PIN_LENGTH of src/core/pin, from the server) */
  readonly length: number
  readonly value: string
  readonly onChange: (pin: string) => void
  readonly hint?: string
  readonly error?: string
  readonly name?: string
  readonly disabled?: boolean
}

export function PinInput({ id, label, length, value, onChange, hint, error, name, disabled }: PinInputProps) {
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
      <input
        id={id}
        name={name}
        type="password"
        inputMode="numeric"
        pattern={`[0-9]{${length}}`}
        autoComplete="one-time-code"
        autoCorrect="off"
        autoCapitalize="off"
        enterKeyHint="done"
        spellCheck={false}
        minLength={length}
        value={value}
        disabled={disabled}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onChange(pinDigits(event.currentTarget.value, length))}
        className={cn(
          'tabular h-12 w-full max-w-[14rem] rounded-md border border-input bg-bg px-3 text-center text-xl tracking-[0.4em] text-ink',
          'aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-ink-muted',
        )}
      />
      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-danger">
          <NoticeIcon tone="danger" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}
