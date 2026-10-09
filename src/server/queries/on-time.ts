import { addBusinessMinutes, type BusinessCalendar } from '@/core/sla'
import { MS_PER_DAY } from '@/lib/constants'

// The on-time figures of the home page (spec §11.5, FR-VIS-006 AC3) as pure functions over rows already read, so they
// are tested on data whose answers are known: approval tasks due in a window, request lines waiting in the
// procurement queue, the whole percent and the change in points from the window before. ./home.ts reads the rows.

/** W: the window of the on-time figures, and the one before it to compare with (§11.5) */
export const ON_TIME_WINDOW_DAYS = 30
/** "งานของฉัน" shows for a member who had a task in the last 60 days (§9.10) */
export const MY_TASKS_LOOKBACK_DAYS = 60
/** The card "ที่ฉันติดตาม" lists the five requests that moved last (§9.10) */
export const FOLLOWING_ROWS = 5
/** The card "รอฉันอนุมัติ" lists the first ten of each tab, the earliest due first (§9.10) */
export const APPROVAL_ROWS = 10

const PERCENT = 100

export interface Window {
  readonly from: Date
  readonly to: Date
}

/** The last 30 days up to now, and the 30 days before them */
export function onTimeWindows(now: Date): { readonly current: Window; readonly previous: Window } {
  const span = ON_TIME_WINDOW_DAYS * MS_PER_DAY
  const from = new Date(now.getTime() - span)
  return { current: { from, to: now }, previous: { from: new Date(from.getTime() - span), to: from } }
}

/** On time and late in one window; `pct` the whole percent of on time (half up), null when nothing counts */
export interface OnTimeCount {
  readonly onTime: number
  readonly late: number
  readonly pct: number | null
}

export interface OnTimeFigure {
  readonly current: OnTimeCount
  /** The current percent less the previous one in whole points (half away from zero); null when the previous window had nothing */
  readonly deltaPoints: number | null
}

/** a ÷ b as a whole percent, half up (b > 0) */
const percentOf = (a: number, b: number) => Math.floor((a * PERCENT * 2 + b) / (b * 2))

export function countOf(onTime: number, late: number): OnTimeCount {
  return { onTime, late, pct: onTime + late > 0 ? percentOf(onTime, onTime + late) : null }
}

/** (a/b − c/d) in whole points, half away from zero (b, d > 0) */
function pointsBetween(a: number, b: number, c: number, d: number): number {
  const num = PERCENT * (a * d - c * b)
  const den = b * d
  const whole = Math.floor((Math.abs(num) * 2 + den) / (den * 2))
  return num < 0 ? -whole : whole
}

/** The current window against the previous one */
export function figureOf(current: OnTimeCount, previous: OnTimeCount): OnTimeFigure {
  const n = current.onTime + current.late
  const p = previous.onTime + previous.late
  return { current, deltaPoints: n > 0 && p > 0 ? pointsBetween(current.onTime, n, previous.onTime, p) : null }
}

// ---------- on-time approval tasks ----------

export interface OnTimeTask {
  readonly status: string
  readonly dueAt: Date | null
  readonly decidedAt: Date | null
}

/** Statuses of a decided task */
const DECIDED = new Set(['APPROVED', 'REJECTED', 'RETURNED'])

/**
 * §11.5 "งานอนุมัติทันเวลา": the tasks whose due time falls in the window — on time when decided by then, late when decided
 * after it or still OPEN past it. A task waiting for an answer (its SLA stopped), cancelled or reassigned does not count.
 */
export function onTimeOfTasks(tasks: readonly OnTimeTask[], window: Window, now: Date): OnTimeCount {
  let onTime = 0
  let late = 0
  for (const t of tasks) {
    if (!t.dueAt || t.dueAt < window.from || t.dueAt >= window.to) continue
    if (DECIDED.has(t.status) && t.decidedAt) {
      if (t.decidedAt <= t.dueAt) onTime++
      else late++
    } else if (t.status === 'OPEN' && t.dueAt < now) late++
  }
  return countOf(onTime, late)
}

export interface QueueLine {
  /** When the request was approved: its request.approved */
  readonly approvedAt: Date
  /** The first po.submitted of a PO that orders the line, or null */
  readonly submittedAt: Date | null
  /** When the request was cancelled, or null */
  readonly cancelledAt: Date | null
}

/**
 * §11.5 "คิวจัดซื้อทันเวลา": request lines approved in the window — on time when a PO ordering them was sent for approval
 * within `targetMinutes` business minutes of the approval; late when sent after, or not sent and past it. A line not
 * past it and not sent yet, or cancelled before it without a PO sent, does not count.
 */
export function onTimeOfQueue(lines: readonly QueueLine[], window: Window, now: Date, targetMinutes: number, calendar: BusinessCalendar): OnTimeCount {
  let onTime = 0
  let late = 0
  for (const l of lines) {
    if (l.approvedAt < window.from || l.approvedAt >= window.to) continue
    const deadline = addBusinessMinutes(l.approvedAt, targetMinutes, calendar)
    if (l.submittedAt) {
      if (l.submittedAt <= deadline) onTime++
      else late++
    } else if (l.cancelledAt && l.cancelledAt <= deadline) continue
    else if (now > deadline) late++
  }
  return countOf(onTime, late)
}
