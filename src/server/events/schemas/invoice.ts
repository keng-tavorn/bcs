import { z } from 'zod'
import { defineEvents } from '../registry'

// Tier-2 invoice events (spec §10.2 "invoice", docs/sub-specs/S8.md "State machine"): the draft, its coding, the
// submit and what the match decided. Amounts are satang as text. The supplier's invoice number is the supplier's, not
// personal data; no file content and no line text is carried.

const satang = z.string().regex(/^\d+$/)
const exceptionType = z.enum(['PRICE_OVER', 'QTY_NOT_RECEIVED', 'QTY_OVER_ORDERED', 'ACCEPTANCE_PENDING', 'VAT_MISMATCH', 'VAT_SUPPLIER_NOT_REGISTERED', 'POSSIBLE_DUPLICATE', 'BUDGET_SHORT'])

defineEvents('Invoice', {
  'invoice.drafted': {
    schema: z.object({
      poId: z.uuid(),
      supplierId: z.uuid(),
      channel: z.enum(['EMAIL', 'UPLOAD', 'PORTAL']),
      prefill: z.enum(['MANUAL', 'ETAX_XML', 'AI_READING']),
      /** S13: the AgentAction whose reading made the draft; null otherwise */
      agentActionId: z.uuid().nullable(),
      sourceFileId: z.uuid().nullable(),
      lineCount: z.number().int().min(0),
    }),
  },
  'invoice.updated': { schema: z.object({ changed: z.array(z.string()).min(1), netSatang: satang, statedVatSatang: satang }) },
  'invoice.coding_confirmed': {
    schema: z.object({ lines: z.array(z.object({ invoiceLineId: z.uuid(), accountCode: z.string().min(1), costCenterId: z.uuid(), source: z.enum(['HISTORY', 'BUDGET_LINE', 'MANUAL']) })).min(1) }),
  },
  'invoice.submitted': {
    schema: z.object({
      number: z.string().min(1),
      supplierInvoiceNoNormalized: z.string().min(1),
      netSatang: satang,
      statedVatSatang: satang,
      grossSatang: satang,
      matchId: z.uuid(),
    }),
  },
  'invoice.matched': { schema: z.object({ matchId: z.uuid(), runNo: z.number().int().min(1), netSatang: satang }) },
  'invoice.exception_raised': {
    schema: z.object({
      matchId: z.uuid(),
      runNo: z.number().int().min(1),
      exceptions: z.array(z.object({ type: exceptionType, amountSatang: satang, lineNo: z.number().int().min(1).nullable() })).min(1),
    }),
  },
  'invoice.ready': {
    schema: z.object({ dueDate: z.iso.date(), payableSatang: satang, expectedWhtSatang: satang, actualSatang: satang, holdMoreSatang: satang, releasedSatang: satang }),
  },
  'invoice.cancelled': { schema: z.object({ reason: z.string().min(1) }) },
})
