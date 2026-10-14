import { BP_PER_WHOLE } from '../money/constants'
import { allocateLargestRemainder, lineNet, parseQuantity, roundHalfUpDiv, vatFromNet, type Satang } from '../money/math'
import { formatQuantity } from '../receiving'

// Milestones and performance retention of service contracts (ADR-124, BR-RET-01 to BR-RET-04, OQ-125). A service PO
// line is split into 2–12 milestones by shares in basis points: the quantity (in 0.0001 units) by largest remainder,
// each milestone priced as its own line, so the milestones may differ from the single line by a satang (the drift).
// Each invoice holds back its retention — the first part of a two-part largest-remainder split of its amount before VAT,
// which is half up — owed later when the retention is released; tax is withheld at payment on what is paid (OQ-122).

const MIN_MILESTONES = 2
const MAX_MILESTONES = 12

export type SplitMilestones =
  | { readonly ok: true; readonly lines: ReadonlyArray<{ readonly qty: string; readonly netSatang: Satang }>; readonly totalSatang: Satang; readonly driftSatang: Satang }
  | { readonly ok: false; readonly code: 'VALIDATION_FAILED'; readonly reason: 'SHARES' | 'QUANTITY' }

/** BR-RET-01: a line of `qty` at `unitPriceSatang` split by `sharesBp` (2–12 shares, each above 0, adding up to 10000) */
export function splitMilestones(qty: string, unitPriceSatang: Satang, sharesBp: readonly number[]): SplitMilestones {
  if (sharesBp.length < MIN_MILESTONES || sharesBp.length > MAX_MILESTONES || sharesBp.some((s) => !Number.isInteger(s) || s <= 0) || BigInt(sharesBp.reduce((a, s) => a + s, 0)) !== BP_PER_WHOLE) {
    return { ok: false, code: 'VALIDATION_FAILED', reason: 'SHARES' }
  }
  const units = parseQuantity(qty)
  const parts = allocateLargestRemainder(units, sharesBp.map((s) => BigInt(s)))
  if (parts.some((p) => p === 0n)) return { ok: false, code: 'VALIDATION_FAILED', reason: 'QUANTITY' }
  const lines = parts.map((p) => {
    const q = formatQuantity(p)
    return { qty: q, netSatang: lineNet(q, unitPriceSatang) }
  })
  const total = lines.reduce((a, l) => a + l.netSatang, 0n)
  return { ok: true, lines, totalSatang: total, driftSatang: total - lineNet(qty, unitPriceSatang) }
}

/** BR-RET-03: the retention of an invoice's amount before VAT (half up, as the first of two largest-remainder parts) */
export function retentionOf(netSatang: Satang, retentionBp: number): Satang {
  if (!Number.isInteger(retentionBp) || retentionBp < 0 || BigInt(retentionBp) > BP_PER_WHOLE) throw new RangeError(`invalid retention: ${retentionBp} bp`)
  return allocateLargestRemainder(netSatang, [BigInt(retentionBp), BP_PER_WHOLE - BigInt(retentionBp)])[0]!
}

export interface InvoicePayment {
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly retentionSatang: Satang
  /** gross − retention: Invoice.payableSatang, before tax */
  readonly payableSatang: Satang
  readonly whtBaseSatang: Satang
  readonly whtSatang: Satang
  /** payable − tax: what is transferred when the invoice is paid alone */
  readonly transferSatang: Satang
}

/** BR-RET-03, BR-WHT-05: one invoice of one income type paid alone */
export function invoicePayment(netSatang: Satang, vatRateBp: number, retentionBp: number, whtRateBp: number): InvoicePayment {
  if (netSatang < 0n) throw new RangeError('the amount before VAT cannot be below zero')
  if (!Number.isInteger(whtRateBp) || whtRateBp < 0) throw new RangeError(`invalid withholding rate: ${whtRateBp} bp`)
  const { vat, gross } = vatFromNet(netSatang, vatRateBp)
  const retention = retentionOf(netSatang, retentionBp)
  const base = netSatang - retention
  const wht = roundHalfUpDiv(base * BigInt(whtRateBp), BP_PER_WHOLE)
  return { vatSatang: vat, grossSatang: gross, retentionSatang: retention, payableSatang: gross - retention, whtBaseSatang: base, whtSatang: wht, transferSatang: gross - retention - wht }
}

/** BR-WHT-05: a released retention paid alone — its base is the retention, at the invoice's rate */
export function retentionRelease(retentionSatang: Satang, whtRateBp: number): { readonly payableSatang: Satang; readonly whtSatang: Satang; readonly transferSatang: Satang } {
  if (retentionSatang < 0n) throw new RangeError('a retention cannot be below zero')
  if (!Number.isInteger(whtRateBp) || whtRateBp < 0) throw new RangeError(`invalid withholding rate: ${whtRateBp} bp`)
  const wht = roundHalfUpDiv(retentionSatang * BigInt(whtRateBp), BP_PER_WHOLE)
  return { payableSatang: retentionSatang, whtSatang: wht, transferSatang: retentionSatang - wht }
}

