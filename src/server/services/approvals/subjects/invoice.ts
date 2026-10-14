import { documentTypeOfSubject } from '@/core/doa'
import { decideVariance } from '../../ap/variance'
import type { SubjectAdapter } from './index'

// The INVOICE approval subject (ADR-068, S8-06): a price variance of a tier-2 invoice sent for approval under DOA
// INVOICE_EXCEPTION (BR-MATCH-10, BR-AP-05, BR-AP-06). The last approval holds what each line lacks and moves the invoice
// to ACTUAL (BR-MATCH-11); a budget line without enough available refuses the decision BUDGET_INSUFFICIENT, the whole
// decision rolls back and the task stays open. A return or a rejection sends the invoice back to EXCEPTION. The card
// and the chat show the numbers and the variance in total only, never a line or a unit price (BR-AP-09, BR-NOTI-01).

export const invoiceSubject: SubjectAdapter = {
  async facts(tx, id) {
    const invoice = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: { number: true, poId: true, recordedById: true, po: { select: { number: true } }, exceptions: { where: { type: 'PRICE_OVER', status: { in: ['ACCEPT_REQUESTED', 'APPROVED', 'OPEN'] } }, orderBy: [{ amountSatang: 'desc' }, { createdAt: 'asc' }], take: 1, select: { invoiceLine: { select: { poLine: { select: { budgetLine: { select: { departmentId: true } } } } } } } } },
    })
    // who asked for the approval: the actor of the last invoice.variance_submitted
    const asked = await tx.event.findFirst({ where: { aggregateId: id, type: 'invoice.variance_submitted' }, orderBy: { seq: 'desc' }, select: { actorMemberId: true } })
    const conflicts = [...new Set([asked?.actorMemberId, invoice.recordedById].filter((m): m is string => !!m))]
    return {
      type: 'INVOICE',
      id,
      documentType: documentTypeOfSubject('INVOICE'),
      number: invoice.number,
      title: invoice.po.number ? `PO ${invoice.po.number}` : null,
      changeKind: null,
      poId: invoice.poId,
      ownerMemberId: asked?.actorMemberId ?? null,
      conflictMemberIds: conflicts,
      chargedDepartmentId: invoice.exceptions[0]?.invoiceLine?.poLine.budgetLine.departmentId ?? null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.documentType, title: facts.title }),
  href: (facts) => `/finance/invoices/${facts.id}`,
  decide: (tx, ctx, task, decision) => decideVariance(tx, ctx, task.step.route.subjectId, decision),
  allowsRequestInfo: false,
  channels: { chatButton: () => true, emailLink: true, liff: true },
  // BR-AP-05: the recorder of the invoice and whoever asked for the approval never approve it
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}
