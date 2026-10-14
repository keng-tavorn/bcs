import { TZDate } from '@date-fns/tz'
import { budgetBurn, type BurnAlert } from '@/core/budget'
import { MS_PER_DAY } from '@/lib/constants'
import { s6SettingsOf } from '@/lib/org-settings'
import type { BudgetAmounts } from './dashboard'

// Burn rate and forecast of budget lines (S6-18 · FR-BUD-104 · BR-BUD-17 · OQ-113): how much of the current budget
// (funded = planned, after transfers and adjustments) committed and actual use, and the fiscal year's forecast at the
// pace so far, with the alerts of the organization's thresholds (budget.alertThresholdsBp, budget.forecastMinElapsedDays).
// The dashboard, the daily summary and the job budget-burn-alerts read them the same way.

export interface BurnDto {
  /** floor((committed + actual) × 10000 ÷ funded); null when nothing is funded */
  readonly usedBp: number | null
  /** The whole year at the pace so far, in basis points; null before forecastMinElapsedDays or when nothing is funded */
  readonly forecastBp: number | null
  readonly alerts: readonly BurnAlert[]
}

export interface BurnContext {
  readonly yearDays: number
  /** Days of the fiscal year gone by today, the first day counting one; the whole year once it has ended */
  readonly elapsedDays: number
  readonly thresholdsBp: readonly number[]
  readonly forecastMinElapsedDays: number
}

/** The calendar day of an instant in a time zone, as a DATE column stores it (midnight UTC) */
function dayIn(at: Date, timezone: string): Date {
  const local = new TZDate(at.getTime(), timezone)
  return new Date(Date.UTC(local.getFullYear(), local.getMonth(), local.getDate()))
}

export function burnContext(year: { readonly startsOn: Date; readonly endsOn: Date }, now: Date, timezone: string, settings: unknown): BurnContext {
  const s6 = s6SettingsOf(settings)
  const yearDays = Math.round((year.endsOn.getTime() - year.startsOn.getTime()) / MS_PER_DAY) + 1
  const gone = Math.round((dayIn(now, timezone).getTime() - year.startsOn.getTime()) / MS_PER_DAY) + 1
  return { yearDays, elapsedDays: Math.min(Math.max(gone, 0), yearDays), thresholdsBp: s6.budgetAlertThresholdsBp, forecastMinElapsedDays: s6.budgetForecastMinElapsedDays }
}

export function burnOf(a: BudgetAmounts, c: BurnContext): BurnDto {
  return budgetBurn({ fundedSatang: a.planned, committedSatang: a.committed, actualSatang: a.actual, ...c })
}
