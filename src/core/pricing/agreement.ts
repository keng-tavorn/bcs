import { TZDate } from '@date-fns/tz'
import { err, ok, type Result } from '../result'
import type { Satang } from '../money/math'
import { THAI_TIME_ZONE } from '../thai/date'

// Agreed prices of the catalogue (spec §7.17, BR-PRC-06 · OQ-114). Pure: the caller loads the agreements and states the
// Thai calendar dates. A period is [validFrom, validTo) in Thai calendar days written YYYY-MM-DD, so two periods that
// meet on a day do not overlap; the periods of one item and one supplier never overlap. A request line from the
// catalogue whose supplier has an agreement in effect takes the agreed price; a supplier without one needs a reason.

export interface AgreementPeriod {
  readonly catalogItemId: string
  readonly supplierId: string
  /** YYYY-MM-DD, included */
  readonly validFrom: string
  /** YYYY-MM-DD, not included */
  readonly validTo: string
}

export interface Agreement extends AgreementPeriod {
  readonly id: string
  /** Before VAT */
  readonly unitPriceSatang: Satang
}

export interface AgreementLine {
  readonly catalogItemId: string
  /** null: no supplier chosen on the line */
  readonly supplierId: string | null
  /** Before VAT */
  readonly unitPriceSatang: Satang
}

/** Whether `add` may be stored beside the agreements already there: its period is a real one and overlaps none of the same item and supplier */
export function checkAgreement(existing: readonly AgreementPeriod[], add: AgreementPeriod): Result<void> {
  if (!(add.validFrom < add.validTo)) return err('VALIDATION_FAILED', 'the period ends before it starts', { field: 'validTo', reason: 'INVALID_PERIOD' })
  const clash = existing.find((e) => e.catalogItemId === add.catalogItemId && e.supplierId === add.supplierId && add.validFrom < e.validTo && e.validFrom < add.validTo)
  return clash ? err('VALIDATION_FAILED', 'the period overlaps an agreement of the same item and supplier', { reason: 'AGREEMENT_OVERLAP' }) : ok(undefined)
}

/** The Thai calendar day of an instant, YYYY-MM-DD: the day an agreement is in effect on */
export function agreementDay(at: Date): string {
  const d = new TZDate(at.getTime(), THAI_TIME_ZONE)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The agreements of an item in effect on a Thai calendar day */
export function agreementsInEffect<A extends AgreementPeriod>(agreements: readonly A[], catalogItemId: string, day: string): A[] {
  return agreements.filter((a) => a.catalogItemId === catalogItemId && a.validFrom <= day && day < a.validTo)
}

/**
 * A catalogue line against the agreements of its item in effect: the line's supplier has one → its price only
 * (AGREEMENT_PRICE_LOCKED) and the line refers to it; the item has agreements but none with the line's supplier → a
 * reason (AGREEMENT_OFF); an item without agreements is free.
 */
export function checkAgreementLine(inEffect: readonly Agreement[], line: AgreementLine, offAgreementReason: string | null): Result<{ readonly priceAgreementId: string | null }> {
  const ofItem = inEffect.filter((a) => a.catalogItemId === line.catalogItemId)
  if (ofItem.length === 0) return ok({ priceAgreementId: null })
  const own = ofItem.find((a) => a.supplierId === line.supplierId)
  if (own) {
    return own.unitPriceSatang === line.unitPriceSatang
      ? ok({ priceAgreementId: own.id })
      : err('VALIDATION_FAILED', 'the line must take the agreed price', { field: 'unitPrice', reason: 'AGREEMENT_PRICE_LOCKED', agreedUnitPriceSatang: own.unitPriceSatang.toString() })
  }
  return (offAgreementReason ?? '').trim() === ''
    ? err('VALIDATION_FAILED', 'another supplier than the agreed one needs a reason', { field: 'offAgreementReason', reason: 'AGREEMENT_OFF' })
    : ok({ priceAgreementId: null })
}
