import { amountToSatang, type MoneyDto } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// Money as the form shows it (§9.9 rule 6): thousands separators and two decimals, from satang or a MoneyDto, never
// through floating point.

export const showSatang = (satang: bigint): string => formatSatang(satang)

export const showMoney = (money: MoneyDto | string): string => formatSatang(amountToSatang(typeof money === 'string' ? money : money.amount))

/** A VAT rate in basis points as a percentage for reading: 700 → "7" */
export function showRate(rateBp: number): string {
  const whole = Math.trunc(rateBp / 100)
  const rest = rateBp % 100
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}
