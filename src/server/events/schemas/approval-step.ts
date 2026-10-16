import { z } from 'zod'
import { APPROVAL_SUBJECTS } from '@/core/sod'
import { defineEvents } from '../registry'

// Approval step events (spec §10.2 "approval_step", S6 · BR-WF-01): a step of several slots — a committee or the
// parallel reviewers — came to its result. A step of one approver ends with its task's decision and has no event of
// its own (as before S6).

defineEvents('ApprovalStep', {
  'approval_step.completed': {
    schema: z.object({
      subjectType: z.enum(APPROVAL_SUBJECTS),
      subjectId: z.uuid(),
      routeId: z.uuid(),
      stepNo: z.number().int().positive(),
      kind: z.enum(['APPROVAL', 'REVIEW']),
      outcome: z.enum(['APPROVED', 'REJECTED', 'RETURNED']),
      quorum: z.enum(['ALL', 'ANY', 'COUNT']),
      quorumCount: z.number().int().positive().nullable(),
      // What each slot came to, slot 1 first: the decision of the slot, or null for a slot closed undecided
      slots: z.array(z.enum(['APPROVE', 'REJECT', 'RETURN']).nullable()).min(1),
    }),
  },
})
