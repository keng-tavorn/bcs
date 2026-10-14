import { z } from 'zod'
import { defineEvents } from '../registry'

// Budget transfers and adjustments (S6-15 · FR-BUD-103 · BR-BUD-09 to BR-BUD-11 · §6.4 BudgetTransfer): drafted, sent
// for approval under the BUDGET_TRANSFER rule with the source line reserved, then approved (the money moves out of the
// source and into the destination — the ledger events budget.transferred_out and budget.transferred_in), rejected,
// returned or cancelled (the reservation comes back). Money as satang text; reasons stay in Comment.

const satang = z.string().regex(/^\d+$/)
const ref = { kind: z.enum(['TRANSFER', 'INCREASE', 'DECREASE']), fromBudgetLineId: z.uuid().nullable(), toBudgetLineId: z.uuid().nullable(), amountSatang: satang }

defineEvents('BudgetTransfer', {
  'budget_transfer.drafted': { schema: z.object(ref) },
  'budget_transfer.submitted': { schema: z.object({ ...ref, number: z.string().min(1), routeId: z.uuid(), resubmitted: z.boolean() }) },
  'budget_transfer.approved': { schema: z.object({ ...ref, number: z.string().min(1) }) },
  'budget_transfer.rejected': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  'budget_transfer.returned': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  'budget_transfer.cancelled': { schema: z.object({ from: z.enum(['DRAFT', 'RETURNED', 'PENDING_APPROVAL']) }) },
})
