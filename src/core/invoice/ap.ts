import { MS_PER_DAY } from '../money/constants'

// Accounts payable rules of a tier-2 invoice that are pure (spec §7.18 BR-AP-07; golden tests/golden/ap.yaml). The
// service reads the terms from the PO, the supplier and settings.ap, never from numbers in code.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

function dayOf(date: string): number {
  const m = DATE.exec(date)
  if (!m) throw new RangeError(`invalid date: ${date}`)
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError(`invalid date: ${date}`)
  return ms / MS_PER_DAY
}

export interface DueDateInput {
  /** "YYYY-MM-DD" */
  readonly invoiceDate: string
  readonly poTermDays: number | null
  readonly supplierTermDays: number | null
  /** settings.ap.defaultTermDays */
  readonly defaultTermDays: number
}

/**
 * BR-AP-07: the invoice date plus the PO's credit days, or the supplier's when the PO has none, or the organization's
 * default — calendar days (OQ-129). Set when the invoice becomes ready for payment.
 */
export function dueDate(input: DueDateInput): string {
  const days = input.poTermDays ?? input.supplierTermDays ?? input.defaultTermDays
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`invalid credit days: ${days}`)
  return new Date((dayOf(input.invoiceDate) + days) * MS_PER_DAY).toISOString().slice(0, 10)
}
