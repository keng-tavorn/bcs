'use client'

import type { ReactNode } from 'react'
import { Field } from '../form/field'
import { useHydrated } from '../form/hydrated'

// The transaction PIN asked for a decision (FR-AUTH-005 AC2, §9.3): six digits on a number keypad, masked while typed,
// never kept by the page after a try. Digits only, at most six (pinFieldDigits, as each change comes in): anything else
// typed or pasted is dropped. The field has no maxLength on purpose: the browser would cut a pasted "582 931" or
// "58-29-31" to its first six characters before the digits are picked out, and in a masked field nobody would see that
// a digit went missing. The PIN is no password of the account, so the field asks browsers and password managers not to
// take it for one: it says it holds a one-time code (autocomplete=one-time-code), which browsers neither save nor fill as
// a password — "off" is not enough, browsers ignore it on a masked field — with the opt-outs of 1Password
// (data-1p-ignore), LastPass (data-lpignore), Bitwarden (data-bwignore) and Dashlane (data-form-type=other), as the PIN
// fields of /settings/pin and LIFF do. That asks; it cannot force a browser. Whatever one keeps, a PIN decides nothing
// without the member's own session, and the server checks the six digits again and counts every wrong PIN
// (src/server/auth/step-up.ts).
// The field takes no digit before the page's script runs (src/ui/form/hydrated.ts): the form it is in is sent by the
// script only, and a PIN typed into the server's HTML could otherwise go with a native submission of that form
// (NFR-SEC-09). Every form that holds it says method="post", and its submit button waits for the script too
// (decision-panel.tsx, policy-decision.tsx).

/** FR-AUTH-005 AC1: a PIN is six digits (PIN_LENGTH of src/core/pin, which the screens' layer does not import) */
const PIN_LENGTH = 6
const PIN_PATTERN = /^[0-9]{6}$/

/** Six digits, nothing else: the check the forms make before they send a PIN */
export const pinIsComplete = (value: string) => PIN_PATTERN.test(value)

/** The digits 0–9 of what was typed or pasted, at most six of them */
export const pinFieldDigits = (raw: string) => raw.replace(/[^0-9]/g, '').slice(0, PIN_LENGTH)

export interface PinFieldProps {
  readonly id: string
  readonly label: ReactNode
  readonly value: string
  readonly onChange: (value: string) => void
  readonly error?: ReactNode
  readonly hint?: ReactNode
  readonly disabled?: boolean
}

export function PinField({ id, label, value, onChange, error, hint, disabled }: PinFieldProps) {
  const hydrated = useHydrated()
  return (
    <Field
      id={id}
      name="pin"
      type="password"
      label={label}
      hint={hint}
      error={error}
      value={value}
      onChange={(event) => onChange(pinFieldDigits(event.currentTarget.value))}
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="one-time-code"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      disabled={disabled || !hydrated}
      className="tabular max-w-48 tracking-widest disabled:cursor-not-allowed disabled:opacity-60"
    />
  )
}
