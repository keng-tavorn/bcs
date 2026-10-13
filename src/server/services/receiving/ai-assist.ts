import type { TenantTx } from '@/server/db/tenant'
import { decimalText, registerAssistSubject } from '../ai/assist-contract'

// The values of a goods receipt by form path (BR-AI-17 of S13, ADR-148): lines.<poLineId>.received — the quantity a
// delivery note says came for each line of the purchase order (ai-dn-map). gr.post takes the values in and posts the
// receipt in one call, so every proposed field must be confirmed in that call (final).

export async function readReceiptForAssist(tx: TenantTx, id: string): Promise<Record<string, string> | null> {
  const lines = await tx.grLine.findMany({ where: { grId: id }, select: { poLineId: true, receivedQuantity: true } })
  if (lines.length === 0) return null
  return Object.fromEntries(lines.map((l) => [`lines.${l.poLineId}.received`, decimalText(l.receivedQuantity)]))
}

registerAssistSubject('GOODS_RECEIPT', { purposes: ['DELIVERY_NOTE_READ'], final: true, read: readReceiptForAssist })
