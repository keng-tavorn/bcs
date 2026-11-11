import { BP_PER_WHOLE, lineNet, parseQuantity, vatFromNet, type Satang } from '../money/math'
import { QUANTITY_SCALE } from '../money/constants'

// The award of an RFx and the price checks around it (spec §7.23, BR-RFX-01 BR-RFX-11 BR-RFX-12 BR-RFX-13 · S10-03).
// Amounts are whole satang; comparisons against a threshold are made on whole numbers so nothing is rounded to decide.

export interface AwardLineInput {
  readonly ref: string
  readonly supplierId: string
  readonly quantity: string
  /** Before VAT */
  readonly unitPriceSatang: Satang
  /** The winning bid's rate; 0 for a supplier not registered for VAT or abroad */
  readonly vatRateBp: number
}

export interface AwardAmount {
  readonly net: Satang
  readonly vat: Satang
  readonly gross: Satang
  /** More than one supplier wins */
  readonly isSplit: boolean
  /** Per supplier in the order first met: its lines before VAT and the VAT of its own document */
  readonly perSupplier: ReadonlyArray<{ readonly supplierId: string; readonly net: Satang; readonly vat: Satang }>
  /** Amount before VAT per line, in the order given */
  readonly lineNet: ReadonlyArray<readonly [string, Satang]>
}

/**
 * BR-RFX-12: the amount of an award — net = Σ lineNet; VAT once per supplier on that supplier's lines (each supplier
 * gets its own PO, so its own document VAT); gross = net + vat. A supplier's lines share one rate.
 */
export function awardAmount(lines: readonly AwardLineInput[]): AwardAmount {
  return awardTotals(lines.map((l) => ({ ref: l.ref, supplierId: l.supplierId, lineNetSatang: lineNet(l.quantity, l.unitPriceSatang), vatRateBp: l.vatRateBp })))
}

/**
 * BR-RFX-12 from the amounts before VAT of the lines as the comparison table holds them (S10-10): a line won by a bid
 * that included VAT has its share of that bid's amount before VAT (OQ-212), not quantity × a price. VAT as awardAmount.
 */
export function awardTotals(lines: ReadonlyArray<{ readonly ref: string; readonly supplierId: string; readonly lineNetSatang: Satang; readonly vatRateBp: number }>): AwardAmount {
  const suppliers = new Map<string, { net: Satang; rateBp: number }>()
  const nets = lines.map((l) => {
    if (l.lineNetSatang < 0n) throw new RangeError(`line ${l.ref} has a negative amount`)
    const s = suppliers.get(l.supplierId)
    if (s && s.rateBp !== l.vatRateBp) throw new RangeError(`supplier ${l.supplierId} has two VAT rates in one award`)
    suppliers.set(l.supplierId, { net: (s?.net ?? 0n) + l.lineNetSatang, rateBp: l.vatRateBp })
    return [l.ref, l.lineNetSatang] as const
  })
  const perSupplier = [...suppliers].map(([supplierId, s]) => ({ supplierId, net: s.net, vat: vatFromNet(s.net, s.rateBp).vat }))
  const net = perSupplier.reduce((a, s) => a + s.net, 0n)
  const vat = perSupplier.reduce((a, s) => a + s.vat, 0n)
  return { net, vat, gross: net + vat, isSplit: suppliers.size > 1, perSupplier, lineNet: nets }
}

/**
 * OQ-212: the highest unit price before VAT a winner who quoted with VAT may confirm — ⌊quoted × 10000 ÷ (10000 + rate)⌋,
 * the price an award line holds until the winner confirms its own (S10-10; S10-11 takes the confirmed one).
 */
export function netUnitPriceCeiling(vatRateBp: number, quotedUnitPriceSatang: Satang): Satang {
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0) throw new RangeError(`invalid VAT rate: ${vatRateBp} bp`)
  if (quotedUnitPriceSatang < 0n) throw new RangeError('a negative price')
  return (quotedUnitPriceSatang * BP_PER_WHOLE) / (BP_PER_WHOLE + BigInt(vatRateBp))
}

/**
 * BR-RFX-12: why an award needs its reason, in this order — not the first ranked on a line, split, a foreign winner, a
 * winning bid past its validity, a winner flagged by the registry or short of required documents (read live), above
 * what the source requests approved, and (RISK on) a high-risk winner not yet cleared.
 */
export const AWARD_REASON_CODES = ['NOT_TOP_SCORE', 'SPLIT', 'FOREIGN', 'BID_EXPIRED', 'SUPPLIER_FLAGGED', 'DOCS_INCOMPLETE', 'ABOVE_REQUEST', 'RISK_NOT_CLEARED'] as const
export type AwardReasonCode = (typeof AWARD_REASON_CODES)[number]

/** The codes in their fixed order, each once */
export function orderReasonCodes(codes: Iterable<AwardReasonCode>): AwardReasonCode[] {
  const set = new Set(codes)
  return AWARD_REASON_CODES.filter((c) => set.has(c))
}

/**
 * BR-RFX-12 (จ · S11 BR-RSK-12): a winner of high risk is cleared when its assessment is CURRENT or EXPIRING or an override
 * is open; a tier other than HIGH needs nothing. An unknown status of a HIGH winner counts as not cleared.
 */
export function riskCleared(risk: { readonly tier: string | null; readonly status?: string | null; readonly openOverrideId?: string | null }): boolean {
  if (risk.tier !== 'HIGH') return true
  if (risk.openOverrideId) return true
  return risk.status === 'CURRENT' || risk.status === 'EXPIRING'
}

/**
 * BR-RFX-13 (OQ-212): the confirmed unit price before VAT of a line won by a bid that included VAT may not exceed the
 * quoted price taken out of VAT — confirmed × (10000 + rate) ≤ quoted × 10000, compared in whole numbers. The service
 * refuses with AWARD_PRICE_EXCEEDS_BID (S10-11) and also checks the bid's total.
 */
export function confirmedNetPriceCap(vatRateBp: number, quotedUnitPriceSatang: Satang, confirmedNetUnitPriceSatang: Satang): boolean {
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0) throw new RangeError(`invalid VAT rate: ${vatRateBp} bp`)
  return confirmedNetUnitPriceSatang * (BP_PER_WHOLE + BigInt(vatRateBp)) <= quotedUnitPriceSatang * BP_PER_WHOLE
}

export interface MinInvites {
  /** The estimate with VAT at the rate of the day */
  readonly estimatedGross: Satang
  readonly minInvites: number
}

/** BR-RFX-01: suppliers to invite at least — `aboveThreshold` when the estimate with VAT exceeds the threshold, else 1 */
export function minInvites(estimatedNetSatang: Satang, vatRateBp: number, settings: { readonly thresholdGrossSatang: Satang; readonly minInvitesAboveThreshold: number }): MinInvites {
  const estimatedGross = vatFromNet(estimatedNetSatang, vatRateBp).gross
  return { estimatedGross, minInvites: estimatedGross > settings.thresholdGrossSatang ? settings.minInvitesAboveThreshold : 1 }
}

export type PriceRefSource = 'AGREEMENT' | 'AGREEMENT_OTHER' | 'CATALOG' | 'HISTORY' | 'MANUAL'
export type PriceFlag = 'ABOVE_AGREEMENT' | 'HIGH' | 'LOW'

/** A bid line's price before VAT: the unit price of a bid before VAT, or the line's share of net over its quantity */
export type BidPrice = { readonly unitPriceSatang: Satang } | { readonly lineNetSatang: Satang; readonly quantity: string }

export interface PriceCheck {
  /** (price − reference) ÷ reference in basis points, cut toward zero (BR-PRC-03); null without a reference */
  readonly deviationBp: number | null
  readonly flag: PriceFlag | null
}

/**
 * BR-RFX-11: a bid line's price against the reference of its line. ABOVE_AGREEMENT when the reference is the bidder's
 * own agreed price and the bid is above it; otherwise HIGH or LOW when it is more than `priceAnomalyBp` away. A bid
 * that included VAT is compared through its line's amount before VAT over the quantity (never stored, never rounded).
 */
export function priceAnomaly(price: BidPrice, reference: { readonly unitPriceSatang: Satang; readonly source: PriceRefSource } | null, priceAnomalyBp: number): PriceCheck {
  if (!Number.isInteger(priceAnomalyBp) || priceAnomalyBp < 0) throw new RangeError(`invalid share: ${priceAnomalyBp} bp`)
  if (reference === null) return { deviationBp: null, flag: null }
  if (reference.unitPriceSatang <= 0n) throw new RangeError('a reference price is positive')
  // price = num ÷ den satang per unit; den carries the quantity scale of a line amount
  const [num, den] = 'unitPriceSatang' in price ? [price.unitPriceSatang, 1n] : [price.lineNetSatang * QUANTITY_SCALE, parseQuantity(price.quantity)]
  if (den === 0n) throw new RangeError('a line of no quantity has no unit price')
  const refScaled = reference.unitPriceSatang * den
  const diff = (num - refScaled) * BP_PER_WHOLE
  const deviationBp = Number(diff / refScaled)
  const limit = refScaled * BigInt(priceAnomalyBp)
  const flag: PriceFlag | null = reference.source === 'AGREEMENT' && num > refScaled ? 'ABOVE_AGREEMENT' : diff > limit ? 'HIGH' : -diff > limit ? 'LOW' : null
  return { deviationBp, flag }
}

/** BR-RFX-11: one flag per bid on a line — every bid's price on the line against the line's reference */
export function priceAnomalyFlags(reference: { readonly unitPriceSatang: Satang; readonly source: PriceRefSource } | null, prices: ReadonlyArray<readonly [string, BidPrice]>, priceAnomalyBp: number): ReadonlyArray<readonly [string, PriceCheck]> {
  return prices.map(([ref, price]) => [ref, priceAnomaly(price, reference, priceAnomalyBp)] as const)
}
