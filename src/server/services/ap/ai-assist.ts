import { satangToAmount } from '@/core/money/dto'
import type { TenantTx } from '@/server/db/tenant'
import { decimalText, registerAssistSubject } from '../ai/assist-contract'

// The values of an invoice of S8 by path (BR-AI-17 of S13, FR-AI-303 AC6, S13-12): what the Document Agent read off an
// invoice and FINANCE ends up with. Paths: supplierInvoiceNo · invoiceDate · statedVat · discount · priceIncludesVat ·
// lines.<poLineId>.quantity|unitPrice. A draft may keep fields waiting until it is submitted (invoice.submit checks).

export async function readInvoiceForAssist(tx: TenantTx, id: string): Promise<Record<string, string> | null> {
  const i = await tx.invoice.findFirst({
    where: { id },
    select: { supplierInvoiceNo: true, invoiceDate: true, statedVatSatang: true, discountSatang: true, priceIncludesVat: true, lines: { select: { poLineId: true, quantity: true, unitPriceSatang: true } } },
  })
  if (!i) return null
  const out: Record<string, string> = { statedVat: satangToAmount(i.statedVatSatang), discount: satangToAmount(i.discountSatang), priceIncludesVat: String(i.priceIncludesVat) }
  if (i.supplierInvoiceNo) out.supplierInvoiceNo = i.supplierInvoiceNo
  if (i.invoiceDate) out.invoiceDate = i.invoiceDate.toISOString().slice(0, 10)
  for (const l of i.lines) {
    out[`lines.${l.poLineId}.quantity`] = decimalText(l.quantity)
    out[`lines.${l.poLineId}.unitPrice`] = satangToAmount(l.unitPriceSatang)
  }
  return out
}

registerAssistSubject('INVOICE', {
  purposes: ['INVOICE_READ'],
  final: false,
  read: readInvoiceForAssist,
  // An invoice is read for a purchase order; it fills an invoice of that order only
  belongsTo: async (tx, invoiceId, other) => other.type === 'PURCHASE_ORDER' && (await tx.invoice.count({ where: { id: invoiceId, poId: other.id } })) === 1,
})
