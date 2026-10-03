import { z } from 'zod'
import { defineEvents } from '../registry'

// Purchase order events (spec §10.2 "po", §6.4 PO table) and the consolidation round that drafts them (§7.10,
// FR-P2P-002). Amounts are satang as text.

const satang = z.string().regex(/^\d+$/)

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
