import { documentTypeOfSubject } from '@/core/doa'
import { approveOverrun, declineOverrun } from '../../budget/overruns'
import type { SubjectAdapter } from './index'

// The BUDGET_OVERRUN approval subject (ADR-068 · S6-16 · FR-BUD-101 · BR-BUD-12): the shortfall of a request waiting for
// the approvers of the OVER_BUDGET rule of the department that owns the budget line. The requester never decides it.
// Approved, the shortfall is funded and earmarked for the request; rejected or returned, nothing moved. Its approvers
// read the source request (request.view ASSIGNED). Decided on the web, LIFF, the chat button and the e-mail link.

export const budgetOverrunSubject: SubjectAdapter = {
  async facts(tx, id) {
    const o = await tx.budgetOverrun.findFirst({
      where: { id },
      select: { number: true, reason: true, submittedById: true, budgetLine: { select: { departmentId: true } }, request: { select: { title: true, number: true } } },
    })
    return {
      type: 'BUDGET_OVERRUN',
      id,
      documentType: documentTypeOfSubject('BUDGET_OVERRUN'),
      number: o?.number ?? null,
      title: o ? (o.request.number ? `${o.request.number} ${o.request.title}` : o.request.title) : null,
      changeKind: null,
      poId: null,
      ownerMemberId: o?.submittedById ?? null,
      conflictMemberIds: o ? [o.submittedById] : [],
      chargedDepartmentId: o?.budgetLine.departmentId ?? null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.documentType, title: facts.title }),
  href: (facts) => `/budgets/overruns/${facts.id}`,
  async decide(tx, ctx, task, decision) {
    const id = task.step.route.subjectId
    if (decision.outcome === 'APPROVED') {
      const approved = await approveOverrun(tx, ctx, id)
      return approved.ok ? { ok: true, documentStatus: 'APPROVED', events: approved.events, notifications: approved.notifications } : approved
    }
    const declined = await declineOverrun(tx, ctx, id, decision.outcome, decision.reasonCommentId)
    return declined.ok ? { ok: true, documentStatus: decision.outcome, events: declined.events, notifications: declined.notifications } : declined
  },
  allowsRequestInfo: false,
  channels: { chatButton: () => true, emailLink: true, liff: true },
  // BR-SOD-01: the requester never approves the shortfall of their own request
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}
