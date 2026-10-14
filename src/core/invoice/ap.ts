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

export interface CodingHistory {
  readonly taxId: string
  readonly categoryCode: string | null
  readonly accountCode: string
  /** "YYYY-MM-DD" of the invoice the code was confirmed on */
  readonly invoiceDate: string
}

export interface SuggestCodingInput {
  /** "YYYY-MM-DD" */
  readonly invoiceDate: string
  readonly taxId: string | null
  readonly categoryCode: string | null
  readonly budgetLine: { readonly accountCode: string | null; readonly costCenter: string }
  /** Confirmed lines of invoices READY_FOR_PAYMENT or later */
  readonly history: readonly CodingHistory[]
  /** How far back the history counts, the invoice's day included (OQ-128) */
  readonly windowDays: number
}

export interface CodingSuggestion {
  readonly accountCode: string | null
  readonly source: 'HISTORY' | 'BUDGET_LINE' | 'NONE'
  /** How many times the history used the code */
  readonly count: number
  readonly costCenter: string
}

/**
 * BR-AP-10 (FR-AP-108, no AI): the account code used most often for the same supplier (tax id) and category in the
 * window before the invoice date, ties to the one used last; else the budget line's code; else none. The cost center is
 * the budget line's. A person confirms every line (invoice.confirmCoding).
 */
export function suggestCoding(input: SuggestCodingInput): CodingSuggestion {
  if (!Number.isInteger(input.windowDays) || input.windowDays < 0) throw new RangeError(`invalid window: ${input.windowDays}`)
  const day = dayOf(input.invoiceDate)
  const uses = new Map<string, { count: number; last: number }>()
  for (const h of input.history) {
    if (input.taxId === null || h.taxId !== input.taxId || h.categoryCode !== input.categoryCode) continue
    const at = dayOf(h.invoiceDate)
    if (at > day || at < day - input.windowDays) continue
    const u = uses.get(h.accountCode) ?? { count: 0, last: -Infinity }
    uses.set(h.accountCode, { count: u.count + 1, last: Math.max(u.last, at) })
  }
  const best = [...uses].sort(([, a], [, b]) => b.count - a.count || b.last - a.last)[0]
  if (best) return { accountCode: best[0], source: 'HISTORY', count: best[1].count, costCenter: input.budgetLine.costCenter }
  if (input.budgetLine.accountCode) return { accountCode: input.budgetLine.accountCode, source: 'BUDGET_LINE', count: 0, costCenter: input.budgetLine.costCenter }
  return { accountCode: null, source: 'NONE', count: 0, costCenter: input.budgetLine.costCenter }
}
