import { z } from 'zod'
import { documentTypeOfSubject } from '@/core/doa'
import { paymentRunSodExtra, recentBankChangeProposers } from '@/core/sod'
import type { SubjectFacts } from '../../sla/subject'
import { rootDepartmentId } from '../../bank-accounts'
import { decidePaymentRun, runApprovalFacts, type RunApprovalFacts } from '../../payments/approval'
import type { SubjectAdapter } from './index'

// The PAYMENT_RUN approval subject (ADR-068, S9-06, BR-PAY-07, BR-PAY-08, BR-SOD-04 BR-SOD-09 BR-SOD-10): a payment run
// sent under DOA PAYMENT_RUN with what it transfers, in the root department's name. Kept off its route and refused at
// deciding: its preparer (BR-SOD-09, through checkSod), the recorders of its invoices (BR-SOD-04) and whoever proposed a
// change of an account it pays into within payment.recentBankChangeDays of its pay date (BR-SOD-10) — the lists of
// paymentRunSodExtra, in that order. The decision takes subjectInput { flagsKey }: the flags the web or LIFF page showed
// (BR-PAY-07); the chat button sends none, so it is offered only for a run sent without flags, and a run that has
// flags by the time it is pressed is PAYMENT_FLAGS_CHANGED. No e-mail link decides it (§9.1). The card names the
// run's number and the total transferred only: no supplier, no account (BR-NOTI-01).
//
// sodContext and channels.chatButton get the facts alone, so what they need beyond SubjectFacts is read with the facts
// and kept beside that very object (the shared decide flow and outsideChannels pass it back unchanged).

const approvalFacts = new WeakMap<SubjectFacts, RunApprovalFacts>()

export const paymentRunSubject: SubjectAdapter = {
  async facts(tx, id) {
    const run = await tx.paymentRun.findFirst({ where: { id }, select: { number: true, preparedById: true, organizationId: true } })
    const extra = run ? await runApprovalFacts(tx, run.organizationId, id) : null
    const facts: SubjectFacts = {
      type: 'PAYMENT_RUN',
      id,
      documentType: documentTypeOfSubject('PAYMENT_RUN'),
      number: run?.number ?? null,
      title: run ? 'รอบจ่ายเงิน' : null,
      changeKind: null,
      poId: null,
      ownerMemberId: run?.preparedById ?? null,
      // BR-DOA-06 for a later step: everyone who may not approve it
      conflictMemberIds: run && extra ? [...new Set([run.preparedById, ...extra.invoiceRecorderMemberIds, ...recentBankChangeProposers(extra.recentBankChanges)])] : [],
      chargedDepartmentId: run ? await rootDepartmentId(tx) : null,
    }
    if (extra) approvalFacts.set(facts, extra)
    return facts
  },
  labels: (facts) => ({ label: facts.number ? `${facts.number} รอบจ่าย` : (facts.title ?? facts.documentType), title: facts.title }),
  href: (facts) => `/finance/payments/${facts.id}`,
  // BR-PAY-07: the flags the decision page showed; none (the chat) counts as ''
  decisionInput: z.strictObject({ flagsKey: z.string().max(20_000) }).optional(),
  decide: (tx, ctx, task, decision) => decidePaymentRun(tx, ctx, task.step.route.subjectId, decision),
  allowsRequestInfo: false,
  // the chat only for a run sent without flags (the amount's step-up is the central files' check, BR-TOK-05); no e-mail link
  channels: { chatButton: (facts) => approvalFacts.get(facts)?.sentFlagsKey === '', emailLink: false, liff: true },
  sodContext: (facts) => {
    const extra = approvalFacts.get(facts)
    return {
      requesterMemberIds: facts.ownerMemberId ? [facts.ownerMemberId] : [],
      ...(extra ? { extra: paymentRunSodExtra({ invoiceRecorderMemberIds: extra.invoiceRecorderMemberIds, recentBankChanges: extra.recentBankChanges }) } : {}),
    }
  },
}
