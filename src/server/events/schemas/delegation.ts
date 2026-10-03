import { z } from 'zod'
import { defineEvents } from '../registry'

// Delegation events (spec §10.2 "delegation"). The reason stays on the row (it is not personal data of a third person).

const instant = z.iso.datetime({ offset: true })

defineEvents('Delegation', {
  'delegation.created': {
    schema: z.object({
      delegatorMemberId: z.uuid(),
      delegateMemberId: z.uuid(),
      startsAt: instant,
      endsAt: instant,
      status: z.enum(['SCHEDULED', 'ACTIVE']),
      createdVia: z.enum(['SELF', 'ORG_AUTHORITY_CHANGE']),
    }),
  },
  'delegation.started': { schema: z.object({ movedTasks: z.number().int().nonnegative() }) },
  'delegation.ended': { schema: z.object({ movedTasks: z.number().int().nonnegative() }) },
  'delegation.revoked': { schema: z.object({ from: z.enum(['SCHEDULED', 'ACTIVE']) }) },
})
