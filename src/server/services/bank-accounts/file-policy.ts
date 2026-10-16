import { recordSensitiveAccess } from '../audit/sensitive-access'
import { registerFileSubjectPolicy } from '../files/policies'
import { mayReadBankProof } from './view'

// The proofs of a bank account change (FileLink BANK_PROOF): a letter or a passbook page shows the account number whole,
// so they open as the number does — FINANCE and the request's approvers (bankAccount.reveal), with module PAY on — and
// every download is a SensitiveAccessLog row (NFR-PRIV-03, BR-SUP-07). Registered when the files service loads.

registerFileSubjectPolicy('BankAccountChange', async (tx, ctx, principal, changeId) => {
  if (!(await mayReadBankProof(tx, ctx, principal, changeId))) return false
  await recordSensitiveAccess(tx, ctx, { subjectType: 'BankAccountChange', subjectId: changeId, fields: ['proof'], purpose: 'download' })
  return true
})
