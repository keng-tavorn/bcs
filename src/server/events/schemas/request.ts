import { z } from 'zod'
import { defineEvents } from '../registry'

// Request events (spec §10.2 "request"). Amounts are satang as decimal strings (JSON has no BigInt); free text such
// as reasons and answers lives in Comment or on the row and is referenced, never copied (spec §4.5).

const satang = z.string().regex(/^\d+$/)
/** FR-BUD-003 AC3: what the submit checked the request against (KPI of G-4) */
const budgetCheck = z.object({ budgetLineId: z.uuid(), availableSatang: satang, reservedSatang: satang })

defineEvents('Request', {
  'request.drafted': {
    // Version 2 (P1-07, docs/sub-specs/P1.md "สัญญากลางอื่น"): where the draft came from and the AI action that made it.
    // Defined once for every lane — S6 writes REORDER and RENEWAL, S13 agentActionId, S17 CHAT_INTAKE; none bumps it
    // again. A version 1 event (neither field) still reads: its source is MANUAL.
    schemaVersion: 2,
    schema: z.object({
      requestTypeCode: z.string().min(1),
      lines: z.number().int().nonnegative(),
      // S2-11 (FR-INT-005, FR-PLT-004 AC2): the change was a file linked to the draft as a kind of attachment, or taken
      // off it. The file name is free text and stays on FileObject (§4.5).
      file: z.object({ action: z.enum(['ATTACHED', 'DETACHED']), fileId: z.uuid(), kinds: z.array(z.string().min(1)).min(1) }).optional(),
      source: z.enum(['MANUAL', 'REORDER', 'RENEWAL', 'CHAT_INTAKE']).default('MANUAL'),
      agentActionId: z.uuid().optional(),
    }),
  },
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
  // FR-INT-006 AC3 (NEW-07, NEW-17): the requester of an idle draft is told when it will be removed
  'request.draft_expiry_notified': { schema: z.object({ deleteOn: z.iso.datetime({ offset: true }) }) },
  'request.info_requested': { schema: z.object({ taskId: z.uuid(), infoRequestId: z.uuid() }) },
  'request.info_provided': { schema: z.object({ taskId: z.uuid(), infoRequestId: z.uuid() }) },
  // FR-INT-013 AC1 (S16-06): a member follows or stops following a request, by themselves (SELF) or by the requester
  'request.follower_added': { schema: z.object({ memberId: z.uuid(), by: z.enum(['SELF', 'REQUESTER']) }).strict() },
  'request.follower_removed': { schema: z.object({ memberId: z.uuid(), by: z.enum(['SELF', 'REQUESTER']) }).strict() },
  // FR-DOA-003 AC3 (§10.1 admin.doa_gap): a submit refused because the DOA names nobody who can approve; the refusal
  // itself is rolled back, so this is recorded and ORG_ADMIN told by a command of its own right after it. Not in the
  // §10.2 catalog yet: the orchestrator records it in an ADR and adds it to §10.2 (see unit a's needs)
  'request.doa_gap_reported': {
    schema: z.object({
      code: z.enum(['DOA_NOT_CONFIGURED', 'APPROVER_NOT_FOUND', 'NO_HIGHER_AUTHORITY', 'REVIEWER_NOT_FOUND']),
      ruleCode: z.string().min(1).nullable(),
      position: z.string().min(1).nullable(),
      departments: z.array(z.string().min(1)),
      notifiedAdmins: z.number().int().nonnegative(),
    }),
  },
})
