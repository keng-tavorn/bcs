import { BP_PER_WHOLE } from '@/core/money/constants'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'

// Figures of the budget screens (§9.9 rule 6): money from its decimal text with thousands separators and exactly two
// decimals, never through floating point; shares from basis points with one decimal, rounded half up — except the
// share left, which the low warning speaks of: it is rounded down, so a line below the warning never reads as at it.

/** { amount: "12345.5" } → "12,345.50" */
export const moneyText = (m: { readonly amount: string }): string => formatSatang(amountToSatang(m.amount))

/** Nothing in this bucket: its amount leads to no document */
export const isZero = (m: { readonly amount: string }): boolean => amountToSatang(m.amount) === 0n

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
