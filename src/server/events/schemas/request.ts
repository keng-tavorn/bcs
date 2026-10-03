import { z } from 'zod'
import { defineEvents } from '../registry'

// Request events (spec §10.2 "request"). Amounts are satang as decimal strings (JSON has no BigInt); free text such
// as reasons and answers lives in Comment or on the row and is referenced, never copied (spec §4.5).

const satang = z.string().regex(/^\d+$/)
/** FR-BUD-003 AC3: what the submit checked the request against (KPI of G-4) */
const budgetCheck = z.object({ budgetLineId: z.uuid(), availableSatang: satang, reservedSatang: satang })

defineEvents('Request', {
  'request.drafted': { schema: z.object({ requestTypeCode: z.string().min(1), lines: z.number().int().nonnegative() }) },
  'request.submitted': {
    // A new-supplier request goes to the procurement queue without a DOA route (OQ-23, FR-INT-007 AC3)
    schema: z.union([
      z.object({ number: z.string().min(1), queue: z.literal('PROCUREMENT') }).strict(),
      z.object({
      number: z.string().min(1),
      netSatang: satang,
      vatSatang: satang,
      grossSatang: satang,
      vatRateBp: z.number().int().nonnegative(),
      routeId: z.uuid(),
      doaVersionId: z.uuid(),
      doaRuleCode: z.string().min(1),
      escalatedFromRuleCode: z.string().min(1).nullable(),
      budgetCheck,
      }),
    ]),
  },
  'request.resubmitted': {
    schema: z.object({ netSatang: satang, vatSatang: satang, grossSatang: satang, routeId: z.uuid(), doaVersionId: z.uuid(), doaRuleCode: z.string().min(1), budgetCheck }),
  },
  'request.returned': { schema: z.object({ taskId: z.uuid(), reasonCommentId: z.uuid() }) },
  'request.approved': { schema: z.object({ routeId: z.uuid(), doaVersionId: z.uuid(), doaRuleCode: z.string().min(1) }) },
  'request.rejected': { schema: z.object({ taskId: z.uuid(), reasonCommentId: z.uuid() }) },
  'request.cancelled': { schema: z.object({ from: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  'request.info_requested': { schema: z.object({ taskId: z.uuid(), infoRequestId: z.uuid() }) },
  'request.info_provided': { schema: z.object({ taskId: z.uuid(), infoRequestId: z.uuid() }) },
})
