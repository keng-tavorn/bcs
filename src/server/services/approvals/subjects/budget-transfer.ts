import { documentTypeOfSubject } from '@/core/doa'
import { approveTransfer, declineTransfer } from '../../budget/transfers'
import type { SubjectAdapter } from './index'

// The BUDGET_TRANSFER approval subject (ADR-068 · S6-15 · FR-BUD-103 · BR-BUD-11): a transfer, increase or decrease of
// budget waiting for the approvers of the BUDGET_TRANSFER rule of the department whose line gives (or receives, for an
// increase). The one who sent it never decides it. Approved, the money moves; rejected or returned, the source's
// reservation comes back. Decided on the web, LIFF, the chat button and the e-mail link like a request (no step-up of
// its own beyond the DOA version's threshold).

export const budgetTransferSubject: SubjectAdapter = {
  async facts(tx, id) {
    const t = await tx.budgetTransfer.findFirst({
      where: { id },
      select: { number: true, kind: true, reason: true, submittedById: true, fromBudgetLine: { select: { departmentId: true } }, toBudgetLine: { select: { departmentId: true } } },
    })
    const department = t ? (t.kind === 'INCREASE' ? t.toBudgetLine?.departmentId : t.fromBudgetLine?.departmentId) : null
    return {
      type: 'BUDGET_TRANSFER',
      id,
      documentType: documentTypeOfSubject('BUDGET_TRANSFER'),
      number: t?.number ?? null,
      title: t?.reason ?? null,
      changeKind: null,
      poId: null,
      ownerMemberId: t?.submittedById ?? null,
      conflictMemberIds: t ? [t.submittedById] : [],
      chargedDepartmentId: department ?? null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.documentType, title: facts.title }),
  href: (facts) => `/budgets/transfers/${facts.id}`,
  async decide(tx, ctx, task, decision) {
    const id = task.step.route.subjectId
    if (decision.outcome === 'APPROVED') {
      const approved = await approveTransfer(tx, ctx, id)
      return approved.ok ? { ok: true, documentStatus: 'APPROVED', events: approved.events, notifications: approved.notifications } : approved
    }
    const declined = await declineTransfer(tx, ctx, id, decision.outcome, decision.reasonCommentId)
    return declined.ok ? { ok: true, documentStatus: decision.outcome, events: declined.events, notifications: declined.notifications } : declined
  },
  allowsRequestInfo: false,
  channels: { chatButton: () => true, emailLink: true, liff: true },
  // BR-SOD-01: the sender never approves their own transfer
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}
