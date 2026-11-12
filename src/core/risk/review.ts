import { BP_PER_WHOLE } from '../money/constants'
import { dateIn } from '../supplier-docs'
import type { RiskTierDef } from './types'

// BR-RSK-13: the dates of a completed assessment — the day it completed in Asia/Bangkok, the last day it is valid (the
// tier's months later, a day past the end of the month falling back to the month's last day) and the day reminders
// start. Dates are calendar days written YYYY-MM-DD. Pure.

const pad = (n: number) => String(n).padStart(2, '0')
const parts = (day: string): [number, number, number] => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return [y, m, d]
}

/** `months` calendar months after `day`; a day the month does not have becomes its last day (31 Jan + 1 = 28/29 Feb) */
export function addCalendarMonths(day: string, months: number): string {
  const [y, m, d] = parts(day)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${pad(month)}-${pad(Math.min(d, last))}`
}

/** `days` calendar days after (or before, when negative) `day` */
export function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = parts(day)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

export interface ReviewDates {
  readonly completedOn: string
  readonly validUntil: string
  readonly remindOn: string
}

/** BR-RSK-10 (GC-RSK-73 · S11-08): the last day an override sent on `submittedOn` may run to — the send day + overrideMaxDays */
export function overrideWindow(input: { readonly submittedOn: string; readonly overrideMaxDays: number }): { readonly lastAllowed: string } {
  return { lastAllowed: addCalendarDays(input.submittedOn, input.overrideMaxDays) }
}

export type OverrideExpiryReason = 'OVERRIDE_EXPIRY_PAST' | 'OVERRIDE_EXPIRY_TOO_FAR'

/**
 * BR-RSK-10 (GC-RSK-74 to 76 · S11-08): an override's last day is the send day at the earliest (the day itself counts, as
 * the gate's "รวมวันนั้น" and the table's CHECK) and the window's last day at the latest
 */
export function overrideExpiryCheck(input: {
  readonly submittedOn: string
  readonly expiresOn: string
  readonly overrideMaxDays: number
}): { readonly ok: true } | { readonly ok: false; readonly error: 'VALIDATION_FAILED'; readonly reason: OverrideExpiryReason } {
  if (input.expiresOn < input.submittedOn) return { ok: false, error: 'VALIDATION_FAILED', reason: 'OVERRIDE_EXPIRY_PAST' }
  if (input.expiresOn > overrideWindow(input).lastAllowed) return { ok: false, error: 'VALIDATION_FAILED', reason: 'OVERRIDE_EXPIRY_TOO_FAR' }
  return { ok: true }
}

/** BR-RSK-13: completedOn, validUntil = completedOn + reviewMonths, remindOn = validUntil − reminderDaysBefore */
export function reviewDates(completedAt: Date, tier: Pick<RiskTierDef, 'reviewMonths' | 'reminderDaysBefore'>, timezone: string): ReviewDates {
  const completedOn = dateIn(completedAt, timezone)
  const validUntil = addCalendarMonths(completedOn, tier.reviewMonths)
  return { completedOn, validUntil, remindOn: addCalendarDays(validUntil, -tier.reminderDaysBefore) }
}

/** One supplier whose first PO falls in the period: its gate tier was HIGH, and it passed by an assessment (BR-RSK-15) */
const WHOLE_BP = Number(BP_PER_WHOLE)

export interface G9Row {
  readonly high: boolean
  readonly assessed: boolean
}

export interface G9Rate {
  /** floor(numerator × 10000 ÷ denominator); null when no HIGH supplier had its first PO in the period */
  readonly bp: number | null
  readonly numerator: number
  readonly denominator: number
}

/**
 * BR-RSK-15 (KPI G-9 · GC-RSK-69 to 72 · S11-09): of the suppliers whose first PO in the period met the gate at tier HIGH,
 * the share assessed before that PO — an override counts below the line only. Basis points, rounded down.
 */
export function g9Rate(rows: readonly G9Row[]): G9Rate {
  const high = rows.filter((r) => r.high)
  const numerator = high.filter((r) => r.assessed).length
  const denominator = high.length
  return { bp: denominator === 0 ? null : Math.floor((numerator * WHOLE_BP) / denominator), numerator, denominator }
}
