import { satangOf } from '@/core/forms/money-text'
import { amountToSatang, type MoneyDto } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// Money as the form shows it (§9.9 rule 6): thousands separators and two decimals, from satang or a MoneyDto, never
// through floating point.

export const showSatang = (satang: bigint): string => formatSatang(satang)

export const showMoney = (money: MoneyDto | string): string => formatSatang(amountToSatang(typeof money === 'string' ? money : money.amount))

/**
 * An amount a person typed, as it reads once typed: "140000" or "140,000.5" → "140,000.50"; null when the text is no
 * amount (separators and spaces aside, as model.ts plainNumber reads it). Only for the screen: the form keeps the text.
 */
export function readableMoney(typed: string): string | null {
  const satang = satangOf(typed.replace(/[\s,]/g, ''))
  return satang === null ? null : formatSatang(satang)
}

/** A VAT rate in basis points as a percentage for reading: 700 → "7" */
export function showRate(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100)
  const rest = rateBp % 100
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}
