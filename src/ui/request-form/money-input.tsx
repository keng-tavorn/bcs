'use client'

import { useState, type InputHTMLAttributes } from 'react'
import { readableMoney } from './money'

/**
 * A field for an amount of money (§9.9 rule 6: right-aligned tabular digits, thousands separators, two decimals): the
 * text as the person types it while the field has the focus, and the amount grouped with two decimals ("140,000.00") once
 * they leave it. Only the screen changes: the form keeps the text as typed, and what reads it — the totals, the checks,
 * the draft that is saved — takes the separators out (model.ts plainNumber). Text that is no amount stays as typed, with
 * its error beside it.
 */
export function MoneyInput({ value, onFocus, onBlur, ...input }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & { readonly value: string }) {
  const [typing, setTyping] = useState(false)
  return (
    <input
      {...input}
      inputMode="decimal"
      value={typing ? value : (readableMoney(value) ?? value)}
      onFocus={(event) => {
        setTyping(true)
        onFocus?.(event)
      }}
      onBlur={(event) => {
        setTyping(false)
        onBlur?.(event)
      }}
    />
  )
}
