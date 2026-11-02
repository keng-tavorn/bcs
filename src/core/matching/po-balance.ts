import { BP_PER_WHOLE, type Satang } from '../money/math'

// What a PO has left once its invoices are taken off it (NEW-115 · FR-AP-102 AC8): the bar on the page of a tier-2
// invoice, amounts before VAT. It reads what the invoices already say and decides nothing: the match of BR-MATCH-06 and
// BR-MATCH-08 goes line by line and is not this figure. Pure, and it can go below zero: a variance that was approved
// takes an invoice past its PO, and the bar says so.

export interface PoBalanceInput {
  readonly poNetSatang: Satang
  /** The other invoices of the PO that count (the statuses BR-MATCH-08 counts) */
  readonly otherInvoicedSatang: Satang
  readonly thisNetSatang: Satang
  /** A rejected or cancelled invoice comes off nothing */
  readonly thisCounts: boolean
}

export interface PoBalance extends PoBalanceInput {
  /** What this invoice takes off the PO: its amount, or nothing once it is rejected or cancelled */
  readonly thisTakenSatang: Satang
  /** Below zero when the invoices are over the PO */
  readonly remainingSatang: Satang
}

export function poBalance(input: PoBalanceInput): PoBalance {
  const thisTakenSatang = input.thisCounts ? input.thisNetSatang : 0n
  return { ...input, thisTakenSatang, remainingSatang: input.poNetSatang - input.otherInvoicedSatang - thisTakenSatang }
}

/**
 * How much of the bar each part fills, in basis points, for drawing only: over the PO's amount, or over everything taken
 * when that is more, so the parts never run past the bar. A part above zero always shows, however small.
 */
export function poBalanceShares(b: PoBalance): { readonly otherBp: number; readonly thisBp: number } {
  const taken = b.otherInvoicedSatang + b.thisTakenSatang
  const whole = taken > b.poNetSatang ? taken : b.poNetSatang
  if (whole <= 0n) return { otherBp: 0, thisBp: 0 }
  const shareOf = (part: Satang) => (part <= 0n ? 0 : Math.max(1, Number((part * BigInt(BP_PER_WHOLE)) / whole)))
  return { otherBp: shareOf(b.otherInvoicedSatang), thisBp: shareOf(b.thisTakenSatang) }
}
