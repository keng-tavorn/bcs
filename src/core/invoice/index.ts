import { allocateLargestRemainder, type Satang } from '../money/math'

// Simple invoice confirmation (spec §7.12, BR-IVC-02 to BR-IVC-04, tier 1): an invoice recorded against a PO never takes
// more before VAT than the PO still holds (INVOICE_EXCEEDS_COMMITTED); its number is compared with the supplier's
// earlier ones after removing every space and upper-casing (DUPLICATE_INVOICE); its amount before VAT is shared over
// the PO lines in proportion to what each still holds, rounded down to the satang with the leftover satang given one
// by one to the largest remainders, earlier lines first on a tie (the money moves COMMITTED → ACTUAL per line).

export type InvoiceRefusal = 'INVOICE_EXCEEDS_COMMITTED' | 'DUPLICATE_INVOICE'

/** BR-IVC-03: " inv 001" and "INV001" are the same number */
export function normalizeInvoiceNo(invoiceNo: string): string {
  return invoiceNo.replace(/\s+/g, '').toUpperCase()
}

export type ConfirmResult =
  | { readonly ok: true; readonly normalizedNo: string; readonly allocation: readonly Satang[]; readonly remaining: readonly Satang[] }
  | { readonly ok: false; readonly error: InvoiceRefusal; readonly remainingTotal: Satang }

/**
 * Confirms one invoice against what each PO line still holds. `existingNos` are the supplier's numbers already
 * recorded, normalized. Returns how much of the invoice each line takes and what each line holds after it.
 */
export function confirmInvoice(remainingByLine: readonly Satang[], netSatang: Satang, invoiceNo: string, existingNos: ReadonlySet<string>): ConfirmResult {
  if (netSatang <= 0n || remainingByLine.some((r) => r < 0n)) throw new RangeError('an invoice amount above zero and holdings of zero or more are needed')
  const remainingTotal = remainingByLine.reduce((a, b) => a + b, 0n)
  const normalizedNo = normalizeInvoiceNo(invoiceNo)
  if (existingNos.has(normalizedNo)) return { ok: false, error: 'DUPLICATE_INVOICE', remainingTotal }
  if (netSatang > remainingTotal) return { ok: false, error: 'INVOICE_EXCEEDS_COMMITTED', remainingTotal }
  const allocation = allocateLargestRemainder(netSatang, remainingByLine)
  return { ok: true, normalizedNo, allocation, remaining: remainingByLine.map((r, i) => r - allocation[i]!) }
}
