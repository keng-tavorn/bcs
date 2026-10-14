import { z } from 'zod'
import { defineEvents } from '../registry'

// Bank accounts of S9 (docs/sub-specs/S9.md, BR-SUP-06): a supplier's account to be paid into or an account of the
// organization that pays. The full account number is never in Event.data: the last four digits only (BR-BANK-08).

const last4 = z.string().regex(/^\d{4}$/)

defineEvents('BankAccount', {
  'bank_account.activated': {
    schema: z.object({
      ownerKind: z.enum(['SUPPLIER', 'ORGANIZATION']),
      supplierId: z.uuid().nullable(),
      /** An organization's account code, e.g. CB-01 */
      code: z.string().nullable(),
      bankCode: z.string(),
      last4,
      /** SEED: the seed of a sample organization (sourceChangeId null); CHANGE: an approved BankAccountChange */
      via: z.enum(['SEED', 'CHANGE']),
      changeId: z.uuid().nullable(),
    }),
  },
})
