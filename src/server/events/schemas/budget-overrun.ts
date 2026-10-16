import { z } from 'zod'
import { defineEvents } from '../registry'

// Over-budget approval (S6-16 · FR-BUD-101 · BR-BUD-12 to BR-BUD-15, BR-BUD-18 · ADR-105 · §6.4 BudgetOverrun): asked
// for a request whose line has not enough, sent under the OVER_BUDGET rule, then approved (X funded and earmarked for
// the request — the ledger events budget.overrun_funded and budget.reserved), rejected, returned or cancelled; used when
// the request is sent, or lapsed (X goes back outside — budget.overrun_returned); after use, what the request gives back
// takes the unused part of X out of the line (unused_returned). Money as satang text; reasons stay in Comment.

const satang = z.string().regex(/^\d+$/)
const ref = { requestId: z.uuid(), budgetLineId: z.uuid(), number: z.string().min(1) }

defineEvents('BudgetOverrun', {
  'budget_overrun.submitted': { schema: z.object({ ...ref, requestNetSatang: satang, shortfallSatang: satang, routeId: z.uuid() }) },
  'budget_overrun.approved': { schema: z.object({ ...ref, shortfallSatang: satang, lapsesAt: z.iso.datetime({ offset: true }) }) },
  'budget_overrun.rejected': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  'budget_overrun.returned': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  /** Before approval nothing had moved; a request cancelled takes its overrun with it (by: SYSTEM) */
  'budget_overrun.cancelled': { schema: z.object({ number: z.string().min(1), by: z.enum(['REQUESTER', 'REQUEST_CANCELLED']) }) },
  'budget_overrun.consumed': { schema: z.object({ ...ref, usedSatang: satang, returnedSatang: satang }) },
  'budget_overrun.lapsed': { schema: z.object({ ...ref, returnedSatang: satang, by: z.enum(['REQUESTER', 'REQUEST_CANCELLED', 'EXPIRED', 'NOT_USED']) }) },
  /** BR-BUD-15: its requester was reminded, once, two days before lapsesAt */
  'budget_overrun.lapse_reminded': { schema: z.object({ number: z.string().min(1), lapsesAt: z.iso.datetime({ offset: true }) }) },
  /** BR-BUD-18: the part of X a command gave back after use, and how much has gone back after use in all */
  'budget_overrun.unused_returned': { schema: z.object({ ...ref, amountSatang: satang, returnedAfterUseSatang: satang }) },
})
