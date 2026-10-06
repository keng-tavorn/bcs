'use client'

import { useState, type InputHTMLAttributes } from 'react'
import { moneyShown } from './money'

/**
 * A field for an amount of money (§9.9 rule 6: right-aligned tabular digits, thousands separators, two decimals): while
 * the person edits it, the text as they type it — the text the form holds when they start, its raw digits — and the
 * amount grouped with two decimals ("140,000.00") once they leave it (./money.ts moneyShown). Only the screen changes:
 * what the form keeps is its own. The lines and the quotations keep the text as typed, and what reads it — the totals,
 * the checks, the draft that is saved — takes the separators out (model.ts plainNumber); a money question of the form
 * keeps the plain digits the server takes (field-input.tsx, src/ui/liff/requests/field.tsx: plainMoney). Text that is no
 * amount stays as typed, with its error beside it.
 */
export function MoneyInput({ value, onFocus, onChange, onBlur, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & { readonly value: string }) {
  // The text being edited; null while the field does not have the focus
  const [typed, setTyped] = useState<string | null>(null)
  return (
    <input
      {...input}
      inputMode="decimal"
      value={moneyShown(value, typed)}
      onFocus={(event) => {
        setTyped(value)
        onFocus?.(event)
      }}
      onChange={(event) => {
        setTyped(event.currentTarget.value)
        onChange?.(event)
      }}
      onBlur={(event) => {
        setTyped(null)
        onBlur?.(event)
      }}
    />
  )
}
