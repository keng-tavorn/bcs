import { BP_PER_WHOLE, roundHalfUpDiv, vatFromNet, type Satang } from '../money/math'

// Withholding tax on a payment (spec §7.14, BR-WHT-01, a tier 2 preview): the base is the amount before VAT, the rate
// comes from the income type the customer's accountant confirms, and the tax is rounded half up to the satang once
// (BR-MONEY-02). The supplier is paid the amount with VAT less the tax withheld.

export interface Withholding {
  readonly vatSatang: Satang
  readonly whtSatang: Satang
  /** net + VAT − WHT */
  readonly payableSatang: Satang
}

export function withholding(netSatang: Satang, vatRateBp: number, whtRateBp: number): Withholding {
  if (netSatang < 0n) throw new RangeError('the amount before VAT cannot be below zero')
  if (!Number.isInteger(whtRateBp) || whtRateBp < 0) throw new RangeError(`invalid withholding rate: ${whtRateBp} bp`)
  const { vat, gross } = vatFromNet(netSatang, vatRateBp)
  const wht = roundHalfUpDiv(netSatang * BigInt(whtRateBp), BP_PER_WHOLE)
  return { vatSatang: vat, whtSatang: wht, payableSatang: gross - wht }
}
