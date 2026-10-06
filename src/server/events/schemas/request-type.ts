import { z } from 'zod'
import { defineEvents } from '../registry'

// Request types of the catalog (FR-ADM-005 AC2): ORG_ADMIN switches a type on or off and changes its place in the
// catalog. One event per type that changed, with the values it has now (the row keeps only the latest). Pending a row
// in the spec §10.2 catalog (reported by S2-13 unit d as a NEW item, like NEW-12 NEW-14 NEW-16 NEW-17).

defineEvents('RequestType', {
  'request_type.updated': {
    schema: z.object({
      code: z.string().min(1),
      changed: z.array(z.enum(['active', 'sortOrder'])).min(1),
      active: z.boolean(),
      sortOrder: z.number().int(),
    }),
  },
})
