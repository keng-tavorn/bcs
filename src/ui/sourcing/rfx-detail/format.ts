import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { formatScore } from '@/core/sourcing/score'
import { formatEnglishBeDate, formatEnglishBeDateTime, formatThaiDate, formatThaiDateTime } from '@/core/thai/date'
import type { Locale } from './model'

// How the RFx page writes its values: time in Bangkok, Buddhist-era years, baht with two decimals, basis points as a
// percent with two decimals (10000 bp = 100.00).

export const whenText = (locale: Locale, isoText: string): string => (locale === 'en' ? formatEnglishBeDateTime(isoText) : formatThaiDateTime(isoText))
export const dayText = (locale: Locale, isoDay: string): string => (locale === 'en' ? formatEnglishBeDate(isoDay) : formatThaiDate(isoDay))
export const bahtText = (amount: string): string => formatSatang(amountToSatang(amount))
/** Basis points as a percent: 1250 → 12.50, -300 → -3.00 */
export const percentText = (bp: number): string => (bp < 0 ? `-${formatScore(-bp)}` : formatScore(bp))
