import { TZDate } from '@date-fns/tz'
import { MS_PER_DAY } from '../money/constants'
import type { Satang } from '../money/math'
import { THAI_TIME_ZONE } from '../thai/date'

// Asking again (spec §7.17, BR-FORM-07 · BR-FORM-08 · S6-12). Pure: a reorder copies what the current form still asks
// and nothing tied to the old purchase; a service line is reminded before it ends at the milestones of the settings,
// each once, the smallest milestone not below the days left (a missed day still sends it; a passed larger one is never
// sent late). The caller states today's instant and what was sent.

/** BR-FORM-08: whole Thai calendar days from the day of `at` to the day the service ends (negative once it has ended) */
export function daysLeft(at: Date, serviceEndDate: string): number {
  const d = new TZDate(at.getTime(), THAI_TIME_ZONE)
  const today = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((new Date(`${serviceEndDate}T00:00:00Z`).getTime() - today) / MS_PER_DAY)
}

/** BR-FORM-08: the milestone to remind now, or null (none due, already sent, or the service has ended) */
export function renewalMilestoneDue(days: number, sent: readonly number[], milestones: readonly number[]): number | null {
  if (days < 0) return null
  const due = milestones.filter((m) => m >= days)
  if (due.length === 0) return null
  const m = Math.min(...due)
  return sent.includes(m) ? null : m
}

export interface ReorderSourceLine {
  readonly description: string
  readonly categoryCode: string | null
  readonly quantity: string
  readonly uom: string
  /** Before VAT unless the source's prices include VAT */
  readonly unitPriceSatang: Satang
  readonly catalogItemId: string | null
}

export interface ReorderLine extends Omit<ReorderSourceLine, 'unitPriceSatang'> {
  readonly unitPriceSatang: Satang
  /** AGREEMENT: the agreed price of the request's supplier in effect today replaced the old price */
  readonly priceSource: 'SOURCE_REQUEST' | 'AGREEMENT'
}

export interface ReorderInput {
  /** The fields of the request type's current form */
  readonly currentFields: readonly string[]
  readonly fields: Readonly<Record<string, unknown>>
  readonly lines: readonly ReorderSourceLine[]
  readonly supplierId: string | null
  /** The source's prices include VAT: an agreed price (before VAT) never replaces them */
  readonly priceIncludesVat: boolean
  /** Agreed prices in effect today */
  readonly agreements: ReadonlyArray<{ readonly catalogItemId: string; readonly supplierId: string; readonly unitPriceSatang: Satang }>
}

export interface ReorderDraft {
  readonly fields: Record<string, unknown>
  /** Answers of fields the current form no longer has */
  readonly droppedFields: string[]
  readonly lines: ReorderLine[]
}

/**
 * BR-FORM-07: the answers the current form still has and the lines (description, category, quantity, unit, price, item)
 * — a line of an item with an agreed price of the request's supplier takes that price. Never the files, quotations,
 * budget line, service end dates, number or followers (the caller does not copy them).
 */
export function reorderDraft(input: ReorderInput): ReorderDraft {
  const current = new Set(input.currentFields)
  const fields: Record<string, unknown> = {}
  const droppedFields: string[] = []
  for (const [k, v] of Object.entries(input.fields)) {
    if (current.has(k)) fields[k] = v
    else droppedFields.push(k)
  }
  const lines = input.lines.map((l): ReorderLine => {
    const agreed = input.priceIncludesVat || !l.catalogItemId ? undefined : input.agreements.find((a) => a.catalogItemId === l.catalogItemId && a.supplierId === input.supplierId)
    return { ...l, unitPriceSatang: agreed ? agreed.unitPriceSatang : l.unitPriceSatang, priceSource: agreed ? 'AGREEMENT' : 'SOURCE_REQUEST' }
  })
  return { fields, droppedFields, lines }
}
