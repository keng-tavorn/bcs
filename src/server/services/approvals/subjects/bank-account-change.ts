import { documentTypeOfSubject } from '@/core/doa'
import { changeTitle, decideBankAccountChange, rootDepartmentId } from '../../bank-accounts'
import type { SubjectAdapter } from './index'

// The BANK_ACCOUNT_CHANGE approval subject (ADR-068, S9-04, BR-SUP-06): a request to add, replace or close a supplier's
// account or one of the organization's, under DOA BANK_ACCOUNT_CHANGE with no amount in the root department's name
// (BR-PAY-08). Its proposer never decides it (BR-SOD-05 through checkSod). It is decided with a step-up every time
// (ALWAYS_STEP_UP_SUBJECTS), on the web, in the BCS Go app or in LIFF — never from a chat button or an e-mail link, the
// values of the shared base that this adapter must keep (BR-DOA-25). The card and the notices name the request's
// number, its kind and the supplier's code only: never an account's number or name (BR-NOTI-01, BR-BANK-08).

export const bankAccountChangeSubject: SubjectAdapter = {
  async facts(tx, id) {
    const change = await tx.bankAccountChange.findFirst({ where: { id }, select: { number: true, kind: true, submittedById: true, supplier: { select: { code: true } } } })
    return {
      type: 'BANK_ACCOUNT_CHANGE',
      id,
      documentType: documentTypeOfSubject('BANK_ACCOUNT_CHANGE'),
      number: change?.number ?? null,
      title: change ? changeTitle(change) : null,
      changeKind: null,
      poId: null,
      ownerMemberId: change?.submittedById ?? null,
      conflictMemberIds: change ? [change.submittedById] : [],
      chargedDepartmentId: change ? await rootDepartmentId(tx) : null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.title ?? facts.documentType, title: facts.title }),
  href: (facts) => `/finance/bank-accounts/changes/${facts.id}`,
  decide: (tx, ctx, task, decision) => decideBankAccountChange(tx, ctx, task.step.route.subjectId, decision),
  allowsRequestInfo: false,
  // BR-DOA-25: closed on both, whatever the facts; LIFF takes it with its step-up
  channels: { chatButton: () => false, emailLink: false, liff: true },
  // BR-SOD-05: the proposer never approves
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}
