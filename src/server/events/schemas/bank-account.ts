import { z } from 'zod'
import { defineEvents } from '../registry'

// Bank accounts of S9 (docs/sub-specs/S9.md, BR-SUP-06): a supplier's account to be paid into or an account of the
// organization that pays. The full account number is never in Event.data: the last four digits only (BR-BANK-08).

const last4 = z.string().regex(/^\d{4}$/)
const ownerKind = z.enum(['SUPPLIER', 'ORGANIZATION'])
const changeKind = z.enum(['ADD', 'REPLACE', 'CLOSE'])

defineEvents('BankAccount', {
  'bank_account.activated': {
    schema: z.object({
      ownerKind,
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
  // S9-04: the account a REPLACE took the place of, and the account a CLOSE closed, with the change that did it
  'bank_account.superseded': { schema: z.object({ ownerKind, supplierId: z.uuid().nullable(), bankCode: z.string(), last4, changeId: z.uuid(), byBankAccountId: z.uuid() }) },
  'bank_account.closed': { schema: z.object({ ownerKind, supplierId: z.uuid().nullable(), bankCode: z.string(), last4, changeId: z.uuid() }) },
})

// S9-04 (BR-SUP-06, BR-SOD-05, OQ-133): a request to add, replace or close an account, approved under DOA
// BANK_ACCOUNT_CHANGE. The proposed number appears as its last four digits only; the call note never appears.
defineEvents('BankAccountChange', {
  'bank_account_change.drafted': {
    schema: z.object({ kind: changeKind, ownerKind, supplierId: z.uuid().nullable(), targetBankAccountId: z.uuid().nullable(), bankCode: z.string().nullable(), last4: last4.nullable(), sharedAccount: z.boolean() }),
  },
  /** fields: the names of what changed (bankCode, accountNo, proof…), never their values */
  'bank_account_change.updated': { schema: z.object({ fields: z.array(z.string().min(1)).min(1), last4: last4.nullable() }) },
  'bank_account_change.submitted': { schema: z.object({ number: z.string().min(1), routeId: z.uuid(), proofCount: z.number().int().min(0), callVerified: z.boolean(), resubmitted: z.boolean() }) },
  'bank_account_change.approved': { schema: z.object({ number: z.string().min(1), appliedBankAccountId: z.uuid().nullable(), targetBankAccountId: z.uuid().nullable() }) },
  'bank_account_change.rejected': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  'bank_account_change.returned': { schema: z.object({ number: z.string().min(1), reasonCommentId: z.uuid().nullable() }) },
  'bank_account_change.cancelled': { schema: z.object({ from: z.enum(['DRAFT', 'PENDING_APPROVAL']), reason: z.string().min(1) }) },
})
