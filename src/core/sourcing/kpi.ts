import { BP_PER_WHOLE, roundHalfUpDiv, vatFromGross, type Satang } from '../money/math'
import { businessMinutesBetween, type BusinessCalendar } from '../sla'
import { lowerMedian } from '../workflow-reports'
import { businessDayMinutes } from './timing'

// KPI G-8 of sourcing (spec §7.23, BR-RFX-15 · §11.4): the saving of each award against the requests it came from, the
// quarter's total, and the business days from opening an RFx to approving its award. Computed from tables and events,
// never by AI (P-8). A saving may be negative; it is never cut to zero.

export type BaselineKind = 'QUOTATION' | 'ESTIMATE'

/** One source line's baseline: a quotation (the selected one of BR-FORM-06, maybe with VAT) or the requester's estimate */
export type BaselinePart = { readonly kind: BaselineKind; readonly netSatang: Satang } | { readonly kind: 'QUOTATION'; readonly grossSatang: Satang; readonly includesVat: true }

export interface Saving {
  readonly baselineNet: Satang
  readonly baselineKind: BaselineKind | 'MIXED'
  readonly savings: Satang
  /** |saving| × 10000 ÷ baseline rounded half up, with the saving's sign; null on a zero baseline */
  readonly savingsBp: number | null
}

function signedBp(saving: Satang, base: Satang): number | null {
  if (base <= 0n) return null
  const abs = roundHalfUpDiv((saving < 0n ? -saving : saving) * BP_PER_WHOLE, base)
  return Number(saving < 0n ? -abs : abs)
}

/** BR-RFX-15: the saving of one award — baseline before VAT (a quotation with VAT taken out as BR-FORM-06) − awarded */
export function savings(baseline: readonly BaselinePart[], awardedNetSatang: Satang, vatRateBp: number): Saving {
  if (baseline.length === 0) throw new RangeError('an award has at least one source line')
  const baselineNet = baseline.reduce((a, p) => a + ('netSatang' in p ? p.netSatang : vatFromGross(p.grossSatang, vatRateBp).net), 0n)
  const kinds = new Set(baseline.map((p) => p.kind))
  const saving = baselineNet - awardedNetSatang
  return { baselineNet, baselineKind: kinds.size === 1 ? baseline[0]!.kind : 'MIXED', savings: saving, savingsBp: signedBp(saving, baselineNet) }
}

/** BR-RFX-15: the total of a quarter — Σ savings over Σ baselines */
export function savingsTotal(items: ReadonlyArray<{ readonly baselineNet: Satang; readonly savings: Satang }>): { readonly baselineNet: Satang; readonly savings: Satang; readonly savingsBp: number | null } {
  const baselineNet = items.reduce((a, i) => a + i.baselineNet, 0n)
  const saving = items.reduce((a, i) => a + i.savings, 0n)
  return { baselineNet, savings: saving, savingsBp: signedBp(saving, baselineNet) }
}

/** BR-RFX-15: business days from opening to the award's approval, in tenths of a day rounded half up (52 = 5.2 days) */
export function cycleDaysTenths(openedAt: Date, decidedAt: Date, calendar: BusinessCalendar): number {
  const minutes = BigInt(businessMinutesBetween(openedAt, decidedAt, calendar))
  return Number(roundHalfUpDiv(minutes * 10n, BigInt(businessDayMinutes(calendar))))
}

/** BR-RFX-15: each award's days and their lower median (null without an award), in tenths of a day */
export function cycleMedianDays(awards: ReadonlyArray<{ readonly openedAt: Date; readonly decidedAt: Date }>, calendar: BusinessCalendar): { readonly days: readonly number[]; readonly median: number | null } {
  const days = awards.map((a) => cycleDaysTenths(a.openedAt, a.decidedAt, calendar))
  return { days, median: lowerMedian(days) }
}

/** Tenths of a day as shown: 52 → "5.2" */
export function formatTenths(tenths: number): string {
  if (!Number.isInteger(tenths) || tenths < 0) throw new RangeError(`invalid tenths: ${tenths}`)
  return `${Math.floor(tenths / 10)}.${tenths % 10}`
}
