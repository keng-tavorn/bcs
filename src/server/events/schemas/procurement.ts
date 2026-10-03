import { z } from 'zod'
import { defineEvents } from '../registry'

// The procurement pool (spec FR-P2P-001, §7.10): PROCUREMENT chooses the supplier of approved request lines, several
// at once (AC2); lines without one wait in the pool (BR-CONS-03). One event per request whose lines changed.

defineEvents('Request', {
  'request.supplier_assigned': {
    schema: z.object({
      requestLineIds: z.array(z.uuid()).min(1),
      /** null: the choice was taken back */
      supplierId: z.uuid().nullable(),
    }),
  },
})
