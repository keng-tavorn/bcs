'use client'

import { Field } from '../form/field'

// One field of a new transaction PIN on /settings/pin (FR-AUTH-005 AC1): six digits on the phone's number keypad, masked
// while typed. The PIN is not a password of the account, and the browser must never take it for one. autocomplete
// "new-password" says "the account's new password": browsers then offer a generated password here and, once the form
// goes away, offer to save the PIN as the BCS sign-in password — the PIN would then sit in a synced password manager
// (BCS keeps only its argon2id hash, ADR-047 item 1), replace the saved sign-in password and be offered in the PIN field
// of a decision. So the field says it holds a one-time code (autocomplete=one-time-code), which browsers do not save or
// fill as a password, with the opt-outs of 1Password (data-1p-ignore), LastPass (data-lpignore), Bitwarden
// (data-bwignore) and Dashlane (data-form-type=other) — as the LIFF PIN field does (src/ui/liff/pin-input.tsx).
// Digits only, at most six, kept by newPinDigits as each change comes in. The field has no maxLength on purpose: the
// browser would cut a pasted "582 931" or "58-29-31" to its first six characters before the digits are picked out, and
// in a masked field nobody would see that a digit went missing.

/** FR-AUTH-005 AC1: a PIN is six digits (PIN_LENGTH of src/core/pin, which the screens' layer does not import) */
export const NEW_PIN_LENGTH = 6

/** The digits 0–9 of what was typed or pasted, at most six of them */
export function newPinDigits(raw: string): string {
  return raw.replace(/[^0-9]/g, '').slice(0, NEW_PIN_LENGTH)
}

export interface NewPinFieldProps {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly value: string
  readonly onChange: (digits: string) => void
  readonly error?: string
  readonly disabled?: boolean
}

export function NewPinField({ id, name, label, value, onChange, error, disabled }: NewPinFieldProps) {
  return (
    <Field
      id={id}
      name={name}
      type="password"
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
      label={label}
      error={error}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(newPinDigits(event.currentTarget.value))}
      className="tabular tracking-widest"
    />
  )
}
