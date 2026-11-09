import { z } from 'zod'
import { defineEvents } from '../registry'

// The procurement pool (spec FR-P2P-001, §7.10): PROCUREMENT chooses the supplier of approved request lines, several
// at once (AC2); lines without one wait in the pool (BR-CONS-03). One event per request whose lines changed.

defineEvents('Request', {
  'request.supplier_assigned': {
    // S10-11 (schemaVersion 2 · ADR-206): chosen by an approved award, whose approver acts for its submitter (the actor)
    schemaVersion: 2,
    schema: z.object({
      requestLineIds: z.array(z.uuid()).min(1),
      /** null: the choice was taken back */
      supplierId: z.uuid().nullable(),
      via: z.literal('AWARD').optional(),
      awardDecisionId: z.uuid().optional(),
      onBehalfOfMemberId: z.uuid().nullable().optional(),
    }),
  },
  // §6.4: the POs that ordered the request are all closed or cancelled
  'request.completed': { schema: z.object({ purchaseOrderIds: z.array(z.uuid()).min(1) }) },
})
