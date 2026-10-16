import { z } from 'zod'
import { defineEvents } from '../registry'

// Budget events (spec §10.2 "budget", §7.7): one event per operation on one budget line, naming the document that moved
// the money and how much; each BudgetLedgerEntry of the operation names this event (INV-BUD-04). Amounts are satang
// as text (BigInt never goes into JSON as a number).

const satang = z.string().regex(/^\d+$/)
const movement = {
  /** The document whose action moved the money */
  documentType: z.enum(['IMPORT', 'REQUEST', 'PURCHASE_ORDER', 'BUDGET_TRANSFER', 'BUDGET_OVERRUN']),
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
  // S6-15 (BR-BUD-09): a transfer or an adjustment moved money out of the line (AVAILABLE → OUTSIDE) or into it
  'budget.transferred_out': { schema: z.object(movement) },
  'budget.transferred_in': { schema: z.object(movement) },
  // S6-16 (BR-BUD-13 to BR-BUD-15, BR-BUD-18): an approved overrun funded the line, or what it did not use left the line
  'budget.overrun_funded': { schema: z.object(movement) },
  'budget.overrun_returned': { schema: z.object(movement) },
  // S6-18 (BR-BUD-17): an alert the line's burn reached, once per line, alert and fiscal year (not a ledger movement)
  'budget.alert_raised': {
    schema: z.object({ fiscalYearId: z.uuid(), alert: z.string().regex(/^(USED_\d{1,5}|FORECAST_OVER)$/), usedBp: z.number().int().nonnegative(), forecastBp: z.number().int().nonnegative().nullable() }),
  },
})

// Use of another department's budget line (FR-BUD-004 AC1): to one department or one member, for a period
defineEvents('BudgetGrant', {
  'budget_grant.created': {
    schema: z.object({
      budgetLineId: z.uuid(),
      granteeDepartmentId: z.uuid().nullable(),
      granteeMemberId: z.uuid().nullable(),
      validFrom: z.iso.datetime({ offset: true }),
      validTo: z.iso.datetime({ offset: true }).nullable(),
    }),
  },
  'budget_grant.revoked': { schema: z.object({ budgetLineId: z.uuid() }) },
})
