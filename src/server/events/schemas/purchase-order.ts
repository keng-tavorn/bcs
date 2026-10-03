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
  // BR-BUD-06: what happens to the request lines, and the requests whose status moved
  'po.cancelled': { schema: z.object({ from: z.string().min(1), disposition: z.enum(['RETURN_TO_POOL', 'CANCEL_REQUEST_LINES']), reasonCommentId: z.uuid(), requests: z.array(requestStatus) }) },
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
