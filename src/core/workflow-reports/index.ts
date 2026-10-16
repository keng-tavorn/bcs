import { TZDate } from '@date-fns/tz'
import { businessMinutesBetween, WEEKDAYS, type BusinessCalendar, type Weekday } from '../sla'

// Workflow reports (S6-20 · FR-VIS-101 · BR-RPT-03 to BR-RPT-06): cycle time and decision time in business minutes of
// the organization's calendar (the SLA engine, §7.8), the lower median, the order of bottlenecks, the cell of the
// heatmap a decision falls in, and the decisions made by someone the engine would not have chosen. Pure.

/** BR-RPT-03: business minutes from one instant to another (sent → last approval, sent → first PO approved) */
export function cycleMinutes(from: Date, to: Date, calendar: BusinessCalendar): number {
  return businessMinutesBetween(from, to, calendar)
}

/** BR-RPT-03: the time a step's task took to decide, assignedAt → decidedAt, without the business minutes INFO_REQUESTED paused it */
export function decisionMinutes(assignedAt: Date, decidedAt: Date, pauses: ReadonlyArray<{ readonly from: Date; readonly to: Date }>, calendar: BusinessCalendar): number {
  const paused = pauses.reduce((sum, p) => {
    const from = p.from > assignedAt ? p.from : assignedAt
    const to = p.to < decidedAt ? p.to : decidedAt
    return to > from ? sum + businessMinutesBetween(from, to, calendar) : sum
  }, 0)
  return Math.max(0, businessMinutesBetween(assignedAt, decidedAt, calendar) - paused)
}

/** BR-RPT-03: the lower median (of an even count, the lower of the two middle values); null of nothing */
export function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]!
}

/** BR-RPT-04: who or what holds approvals up — most decided late or open past due first, then the longer median */
export function bottlenecks<T extends { readonly overdue: number; readonly median: number | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.overdue - a.overdue || (b.median ?? -1) - (a.median ?? -1))
}

/** BR-RPT-06: the cell of the heatmap an instant falls in: its weekday and hour in the organization's time zone */
export function heatCell(at: Date, timezone: string): { weekday: Weekday; hour: number } {
  const local = new TZDate(at.getTime(), timezone)
  return { weekday: WEEKDAYS[local.getDay()]!, hour: local.getHours() }
}

/**
 * BR-RPT-05: the decisions whose decider is not among the approvers the engine resolves for that moment (DOA, workflow
 * slot, acting appointment) — a delegate counts as the one they acted for
 */
export function wrongDoa<T extends { readonly decider: string; readonly onBehalfOf?: string | null; readonly expected: readonly string[] }>(decisions: readonly T[]): T[] {
  return decisions.filter((d) => !d.expected.includes(d.decider) && !(d.onBehalfOf && d.expected.includes(d.onBehalfOf)))
}
