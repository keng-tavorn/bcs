import { z } from 'zod'
import { defineEvents } from '../registry'

// Purchase order events (spec §10.2 "po", §6.4 PO table) and the consolidation round that drafts them (§7.10,
// FR-P2P-002). Amounts are satang as text.

const satang = z.string().regex(/^\d+$/)
/** A request whose status a PO moved (§6.4: ordered in part or in full, back to the pool, completed) */
const requestStatus = z.object({ requestId: z.uuid(), status: z.string().min(1) })

defineEvents('PurchaseOrder', {
  'po.drafted': {
    schema: z.object({
      supplierId: z.uuid(),
      deliverySiteId: z.uuid().nullable(),
      kind: z.enum(['GOODS', 'SERVICE']),
      urgency: z.enum(['NORMAL', 'URGENT']),
      /** The request lines the PO orders (BR-CONS-04) */
      requestLineIds: z.array(z.uuid()).min(1),
      netSatang: satang,
      consolidationRunId: z.uuid().nullable(),
      via: z.enum(['CONSOLIDATION', 'MANUAL']),
    }),
  },
  // FR-P2P-003 AC2 (NEW-22): the draft changed before it is sent for approval
  'po.updated': { schema: z.object({ changed: z.array(z.string()).min(1), lineCount: z.number().int().min(1), netSatang: satang }) },
  'po.submitted': {
    schema: z.object({
      number: z.string().min(1),
      netSatang: satang,
      vatSatang: satang,
      grossSatang: satang,
      vatRateBp: z.number().int().min(0),
      routeId: z.uuid(),
      doaVersionId: z.uuid(),
      doaRuleCode: z.string().min(1),
      escalatedFromRuleCode: z.string().nullable(),
    }),
  },
  'po.approved': { schema: z.object({ routeId: z.uuid(), doaVersionId: z.uuid(), doaRuleCode: z.string().min(1), requests: z.array(requestStatus) }) },
  'po.rejected': { schema: z.object({ taskId: z.uuid(), reasonCommentId: z.uuid() }) },
  'po.returned': { schema: z.object({ taskId: z.uuid(), reasonCommentId: z.uuid() }) },
  // FR-P2P-005 AC1, AC3: e-mailed to the supplier with its PDF; every send after the first carries a reason
  'po.sent': { schema: z.object({ from: z.string().min(1), resend: z.boolean(), reasonCommentId: z.uuid().nullable(), pdfFileId: z.uuid() }) },
  // FR-P2P-005 AC2 (NEW-25): the supplier's mail server refused the e-mail; the PO keeps its status
  'po.send_bounced': { schema: z.object({ status: z.string().min(1), code: z.string().min(1), resend: z.boolean(), reasonCommentId: z.uuid().nullable(), pdfFileId: z.uuid() }) },
  // BR-BUD-06: what happens to the request lines, and the requests whose status moved
  'po.cancelled': { schema: z.object({ from: z.string().min(1), disposition: z.enum(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES']), reasonCommentId: z.uuid(), requests: z.array(requestStatus) }) },
  // BR-BUD-06: what the PO still holds for goods received and not yet invoiced, and what went back
  'po.closed': { schema: z.object({ from: z.string().min(1), keptSatang: satang, releasedSatang: satang, via: z.enum(['PROCUREMENT', 'CLOSE_SHORT']), requests: z.array(requestStatus) }) },
})

const quantity = z.string().regex(/^\d+(\.\d{1,4})?$/)

// Goods receipts (spec §6.4 GR, BR-GR-01): what came, what was accepted and what was not, per PO line
defineEvents('GoodsReceipt', {
  'gr.posted': {
    schema: z.object({
      number: z.string().min(1),
      poId: z.uuid(),
      lines: z.array(z.object({ poLineId: z.uuid(), received: quantity, accepted: quantity, rejected: quantity })).min(1),
      varianceIds: z.array(z.uuid()),
      poStatus: z.string().min(1),
    }),
  },
  'gr.reversed': { schema: z.object({ poId: z.uuid(), reasonCommentId: z.uuid() }) },
})

// Variances (BR-GR-02 to BR-GR-05): recorded with their disposition; those that need approval go to GR_VARIANCE
defineEvents('Variance', {
  'variance.recorded': {
    schema: z.object({
      poId: z.uuid(),
      poLineId: z.uuid(),
      grId: z.uuid().nullable(),
      type: z.enum(['SHORT', 'OVER', 'DAMAGED']),
      disposition: z.enum(['ACCEPT_EXCESS', 'RETURN_EXCESS', 'ACCEPT_DAMAGED', 'RETURN_REPLACE', 'CLOSE_SHORT']),
      status: z.enum(['RECORDED', 'PENDING_APPROVAL']),
      quantity,
      amountSatang: satang,
      routeId: z.uuid().nullable(),
    }),
  },
  'variance.approved': { schema: z.object({ routeId: z.uuid(), doaVersionId: z.uuid(), doaRuleCode: z.string().min(1), disposition: z.string().min(1) }) },
  'variance.rejected': { schema: z.object({ taskId: z.uuid(), reasonCommentId: z.uuid() }) },
})

// One consolidation round (FR-P2P-002 AC2, AC3, BR-CONS-02), with the drafts it made — none is a result too
defineEvents('ConsolidationRun', {
  'consolidation_run.completed': {
    schema: z.object({
      trigger: z.enum(['SCHEDULED', 'MANUAL', 'URGENT']),
      scheduledFor: z.iso.datetime({ offset: true }).nullable(),
      purchaseOrderIds: z.array(z.uuid()),
      lineCount: z.number().int().min(0),
    }),
  },
})

// Invoices confirmed against a PO (BR-IVC-01 to BR-IVC-04): the share of each PO line and whether the VAT looked off
defineEvents('InvoiceConfirmation', {
  'invoice_confirmation.recorded': {
    schema: z.object({
      poId: z.uuid(),
      supplierId: z.uuid(),
      invoiceNoNormalized: z.string().min(1),
      netSatang: satang,
      vatSatang: satang,
      isFinal: z.boolean(),
      parsedFrom: z.enum(['MANUAL', 'ETAX_XML']),
      allocation: z.array(z.object({ poLineId: z.uuid(), netSatang: satang })),
      vatWarning: z.boolean(),
    }),
  },
})
