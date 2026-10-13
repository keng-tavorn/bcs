import type { AppError } from '@/core/result'
import type { TenantTx } from '@/server/db/tenant'

// Which invoices a PO takes (spec §7.12 BR-IVC-06, ADR-121): the tier-1 confirmations of S4 or the tier-2 invoices of
// S8, never both on one PO (INV-AP-05). The first invoice decides it: with module PAY on it is MATCHING, with PAY off
// CONFIRMATION; a PO that took tier-1 confirmations before the column existed (or before PAY was switched on) keeps
// them. The other kind on the PO is INVOICE_TRACK_MISMATCH. Runs under the PO's lock.

export type InvoiceTrack = 'CONFIRMATION' | 'MATCHING'

/** The track the PO is on: its column, or what invoices it already has (rows from before the column), or none yet */
export async function trackOf(tx: TenantTx, po: { readonly id: string; readonly invoiceTrack: InvoiceTrack | null }): Promise<InvoiceTrack | null> {
  if (po.invoiceTrack) return po.invoiceTrack
  if ((await tx.invoiceConfirmation.count({ where: { poId: po.id } })) > 0) return 'CONFIRMATION'
  if ((await tx.invoice.count({ where: { poId: po.id, status: { not: 'CANCELLED' } } })) > 0) return 'MATCHING'
  return null
}

/**
 * Puts the PO on `wanted` for an invoice of that kind, or refuses. `payOn` says which kind a PO without invoices
 * takes: a tier-1 confirmation on a fresh PO of an organization with PAY on is refused (its invoices are matched).
 */
export async function claimTrack(
  tx: TenantTx,
  po: { readonly id: string; readonly invoiceTrack: InvoiceTrack | null },
  wanted: InvoiceTrack,
  payOn: boolean,
): Promise<{ ok: true } | { ok: false; error: AppError }> {
  const current = (await trackOf(tx, po)) ?? (payOn ? 'MATCHING' : 'CONFIRMATION')
  if (current !== wanted) return { ok: false, error: { code: 'INVOICE_TRACK_MISMATCH', message: `this purchase order takes ${current} invoices`, details: { track: current } } }
  if (po.invoiceTrack !== wanted) await tx.purchaseOrder.update({ where: { id: po.id }, data: { invoiceTrack: wanted } })
  return { ok: true }
}

/** Invoices that keep PAY from being switched off (BR-IVC-06): any not yet paid, rejected or cancelled */
export async function openInvoiceNumbers(tx: TenantTx): Promise<string[]> {
  const rows = await tx.invoice.findMany({
    where: { status: { notIn: ['PAID', 'REJECTED', 'CANCELLED'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 20,
    select: { number: true, supplierInvoiceNo: true, id: true },
  })
  return rows.map((r) => r.number ?? r.supplierInvoiceNo ?? r.id)
}
