import { z } from 'zod'
import { defineEvents } from '../registry'

// Budget events (spec §10.2 "budget", §7.7): one event per operation on one budget line, naming the document that moved
// the money and how much; each BudgetLedgerEntry of the operation names this event (INV-BUD-04). Amounts are satang
// as text (BigInt never goes into JSON as a number).

const satang = z.string().regex(/^\d+$/)
const movement = {
  /** The document whose action moved the money */
  documentType: z.enum(['IMPORT', 'REQUEST', 'PURCHASE_ORDER']),
  documentId: z.uuid(),
  amountSatang: satang,
  /** Ledger rows of the operation, in order */
  seqFrom: z.number().int().positive(),
  seqTo: z.number().int().positive(),
}

defineEvents('BudgetLine', {
  'budget.imported': { schema: z.object(movement) },
  'budget.reserved': { schema: z.object(movement) },
  'budget.reservation_released': { schema: z.object(movement) },
  'budget.committed': { schema: z.object(movement) },
  'budget.commitment_released': { schema: z.object(movement) },
  'budget.actualized': { schema: z.object(movement) },
})
