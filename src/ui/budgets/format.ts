import { BP_PER_WHOLE } from '@/core/money/constants'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// Figures of the budget screens (§9.9 rule 6): money from its decimal text with thousands separators and exactly two
// decimals, never through floating point; shares from basis points with one decimal, rounded half up — except the
// share left, which the low warning speaks of: it is rounded down, so a line below the warning never reads as at it.

/** { amount: "12345.5" } → "12,345.50" */
export const moneyText = (m: { readonly amount: string }): string => formatSatang(amountToSatang(m.amount))

const BP_PER_TENTH_PERCENT = 10

const tenthsText = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}`

/** 833 → "8.3" · 875 → "8.8" · 10000 → "100.0" (half up); null when nothing is planned */
export function percentText(bp: number | null): string | null {
  if (bp === null) return null
  return tenthsText(Math.floor((bp + BP_PER_TENTH_PERCENT / 2) / BP_PER_TENTH_PERCENT))
}

/** The share left, rounded down: 999 → "9.9" · 875 → "8.7" · 1000 → "10.0"; null when nothing is planned */
export function leftPercentText(bp: number | null): string | null {
  if (bp === null) return null
  return tenthsText(Math.floor(Math.max(bp, 0) / BP_PER_TENTH_PERCENT))
}

/** A share as the width of a bar, 0 to 100 (a share above the whole fills it) */
export const shareWidth = (bp: number): number => (Math.min(Math.max(bp, 0), Number(BP_PER_WHOLE)) * 100) / Number(BP_PER_WHOLE)

const BP_PER_PERCENT = 100

/**
 * S6-18 (BR-BUD-17): the burn's share — already rounded down to a basis point by the service — with two decimals, so
 * nothing is rounded again: 8666 → "86.66" · 8000 → "80.00" · 12345 → "123.45"; null when nothing is planned or no
 * forecast is made yet
 */
export function burnPercentText(bp: number | null): string | null {
  if (bp === null) return null
  const whole = Math.max(bp, 0)
  return `${Math.floor(whole / BP_PER_PERCENT)}.${String(whole % BP_PER_PERCENT).padStart(2, '0')}`
}

/** A threshold of the organization as a percent without trailing zeros: 8000 → "80" · 8050 → "80.5" · 8025 → "80.25" */
export function thresholdPercentText(bp: number): string {
  const whole = Math.floor(bp / BP_PER_PERCENT)
  const rest = bp % BP_PER_PERCENT
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}
