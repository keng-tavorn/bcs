import { addBusinessMinutes, subtractBusinessMinutes, type BusinessCalendar } from '../sla'
import { err, ok, type Result } from '../result'
import { addDays } from '../thai/day'
import { taxDateOf } from '../vat'

// Time rules of an RFx (spec §7.23, BR-RFX-02 BR-RFX-07 BR-RFX-14 · S10-03). Business time comes from the
// organization's calendar (§7.8): a business day is as long as the calendar's opening hours (540 minutes for the
// default 08:30–17:30). Calendar days are Thai dates written YYYY-MM-DD; nothing here reads the clock.

export type RfxKind = 'RFQ' | 'RFP' | 'RFI'

export interface SourcingTimeSettings {
  /** Business days an RFx stays open at least, per kind (RFQ 3 · RFP 10 · RFI 5) */
  readonly minOpenBusinessDays: Readonly<Record<RfxKind, number>>
  /** Questions close this many business days before the RFx closes (2) */
  readonly questionCutoffBusinessDays: number
  /** A bid holds its prices this many calendar days from the Thai day it was sent (30) */
  readonly bidValidityDays: number
  /** A preferred supplier from an award is preferred this many calendar days (365 · OQ-210) */
  readonly preferredSupplierDays: number
}

const HHMM = /^(\d{2}):(\d{2})$/

/** Minutes of one business day of the calendar (end − start) */
export function businessDayMinutes(calendar: BusinessCalendar): number {
  const [start, end] = [calendar.start, calendar.end].map((t) => {
    const m = HHMM.exec(t)
    if (!m) throw new RangeError(`invalid time of day: ${t}`)
    return Number(m[1]) * 60 + Number(m[2])
  })
  if (end! <= start!) throw new RangeError('business hours must end after they start')
  return end! - start!
}

function wholeDays(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`days must be a whole number ≥ 0: ${n}`)
  return n
}

/** BR-RFX-02: the earliest an RFx opened at `openedAt` may close — `minOpenBusinessDays` business days later */
export function earliestCloseAt(openedAt: Date, minOpenBusinessDays: number, calendar: BusinessCalendar): Date {
  return addBusinessMinutes(openedAt, wholeDays(minOpenBusinessDays) * businessDayMinutes(calendar), calendar)
}

/** BR-RFX-02: a closing time before the earliest is refused (CLOSE_TOO_SOON); exactly the earliest passes */
export function validateCloseAt(openedAt: Date, closesAt: Date, minOpenBusinessDays: number, calendar: BusinessCalendar): Result<void> {
  const earliest = earliestCloseAt(openedAt, minOpenBusinessDays, calendar)
  return closesAt < earliest ? err('VALIDATION_FAILED', 'the RFx closes before the earliest closing time', { reason: 'CLOSE_TOO_SOON', earliest: earliest.toISOString() }) : ok(undefined)
}

/** BR-RFX-02: questions close `questionCutoffBusinessDays` business days before the RFx closes */
export function questionCutoffAt(closesAt: Date, questionCutoffBusinessDays: number, calendar: BusinessCalendar): Date {
  return subtractBusinessMinutes(closesAt, wholeDays(questionCutoffBusinessDays) * businessDayMinutes(calendar), calendar)
}

/** BR-RFX-02: a bid at the closing second or after is late (RFX_CLOSED) */
export function isLateBid(submittedAt: Date, closesAt: Date): boolean {
  return submittedAt.getTime() >= closesAt.getTime()
}

/** BR-RFX-07: the last Thai day a bid holds its prices — the Thai day it was sent + `bidValidityDays` */
export function bidValidUntil(submittedAt: Date, bidValidityDays: number): string {
  return addDays(taxDateOf(submittedAt), wholeDays(bidValidityDays))
}

/** BR-RFX-12 (ง): a bid is expired on any day after its last valid day */
export function isBidExpired(validUntil: string, day: string): boolean {
  return day > validUntil
}

export interface PreferredWindow {
  /** Thai day of the approval, included */
  readonly validFrom: string
  /** validFrom + preferredSupplierDays, not included */
  readonly validTo: string
}

/** BR-RFX-14: the period a winner is preferred for its category, [Thai day of the approval, + preferredSupplierDays) */
export function preferredWindow(approvedAt: Date, preferredSupplierDays: number): PreferredWindow {
  const validFrom = taxDateOf(approvedAt)
  return { validFrom, validTo: addDays(validFrom, wholeDays(preferredSupplierDays)) }
}

/** BR-RFX-14: validFrom ≤ day < validTo */
export function preferredInEffect(window: PreferredWindow, day: string): boolean {
  return window.validFrom <= day && day < window.validTo
}
