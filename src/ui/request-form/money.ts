import { satangOf } from '@/core/forms/money-text'
import { amountToSatang, type MoneyDto } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// Money as the form shows it (§9.9 rule 6): thousands separators and two decimals, from satang or a MoneyDto, never
// through floating point.

export const showSatang = (satang: bigint): string => formatSatang(satang)

export const showMoney = (money: MoneyDto | string): string => formatSatang(amountToSatang(typeof money === 'string' ? money : money.amount))

/**
 * An amount as a person typed it, without the thousands separators and spaces that are only for reading (as model.ts
 * plainNumber reads it): "140,000.50 " → "140000.50". A money question of the form keeps its answer so: baht text the
 * server takes (MONEY_TEXT). Text that is no amount stays what it is, and the server's refusal names the question.
 */
export function plainMoney(typed: string): string {
  return typed.replace(/[\s,]/g, '')
}

/**
 * An amount a person typed, as it reads once typed: "140000" or "140,000.5" → "140,000.50"; null when the text is no
 * amount (separators and spaces aside). Only for the screen: what the form keeps is the text or its plain digits.
 */
export function readableMoney(typed: string): string | null {
  const satang = satangOf(plainMoney(typed))
  return satang === null ? null : formatSatang(satang)
}

/**
 * What a field for an amount shows (./money-input.tsx): while it is edited, the text as the person types it (`typed`,
 * which starts as the text the form holds: the raw digits, no separators added); otherwise the amount grouped by
 * thousands with two decimals, or text that is no amount as it is.
 */
export function moneyShown(value: string, typed: string | null): string {
  return typed ?? readableMoney(value) ?? value
}

/** A VAT rate in basis points as a percentage for reading: 700 → "7" */
export function showRate(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100)
  const rest = rateBp % 100
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}
