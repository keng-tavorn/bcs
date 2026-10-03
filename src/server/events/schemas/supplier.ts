import { z } from 'zod'
import { defineEvents } from '../registry'

// Supplier register events (spec §10.2 "supplier", §6.2 Supplier, §7.15): who added or changed a supplier and how its
// identity was checked against the Revenue Department and DBD registries (BR-SUP-01 to BR-SUP-05).

const registrySource = z.enum(['RD', 'DBD', 'MANUAL', 'STUB'])

defineEvents('Supplier', {
  'supplier.created': {
    schema: z.object({
      code: z.string(),
      taxId: z.string().nullable(),
      branchCode: z.string(),
      isForeign: z.boolean(),
      registrySource: registrySource.nullable(),
      /** SEED: the demo seed (Appendix A); PROCUREMENT: the register screen or service */
      via: z.enum(['SEED', 'PROCUREMENT']),
    }),
  },
  'supplier.updated': { schema: z.object({ code: z.string(), changed: z.array(z.string()).min(1) }) },
  'supplier.registry_checked': {
    schema: z.object({
      taxId: z.string(),
      branchCode: z.string(),
      sources: z.array(registrySource),
      /** FOUND: filled from a registry · NOT_FOUND / UNAVAILABLE: confirmed by hand with proof (BR-SUP-03) */
      outcome: z.enum(['FOUND', 'NOT_FOUND', 'UNAVAILABLE']),
    }),
  },
  'supplier.registry_status_changed': {
    schema: z.object({ from: z.string().nullable(), to: z.string(), source: registrySource }),
  },
})
