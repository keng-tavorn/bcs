import { documentTypeOfSubject } from '@/core/doa'
import { rejectWithdrawal, withdrawalPending, withdrawalTooLate, withdrawApprovedVersion } from '../../policy-withdrawal'
import { publishApprovedWorkflowVersion, rejectWorkflowVersion } from '../../workflow'
import type { SubjectAdapter } from './index'

// The WORKFLOW_VERSION approval subject (ADR-068, S6-04 · FR-WF-103 · BR-WF-12): a workflow version waiting for the
// approver of the DOA_CHANGE rule, always with a step-up (ALWAYS_STEP_UP_SUBJECTS), never by its submitter, and on the
// web only (OQ-110): no chat button, no e-mail link, no LIFF. Approved, it is published; returned or rejected, it ends
// REJECTED and its submitter makes a new draft. A version still PUBLISHED that was asked to be withdrawn (S6-07 · BR-DOA-18
// by the same rule) is on the route of its withdrawal: who asked never decides it, it is decided only before the version
// takes effect, approving withdraws it and rejecting keeps it.

export const workflowVersionSubject: SubjectAdapter = {
  async facts(tx, id) {
    const v = await tx.workflowVersion.findFirst({
      where: { id },
      select: { code: true, versionNo: true, status: true, changeReason: true, submittedById: true, withdrawalRequestedAt: true, withdrawalRequestedById: true, withdrawalReason: true, submittedBy: { select: { primaryDepartmentId: true } } },
    })
    const root = await tx.department.findFirst({ where: { parentId: null }, select: { id: true } })
    // On the route of its withdrawal, who asked for it is the one who may not decide (BR-SOD-06)
    const owner = v && withdrawalPending(v) ? v.withdrawalRequestedById : (v?.submittedById ?? null)
    return {
      type: 'WORKFLOW_VERSION',
      id,
      documentType: documentTypeOfSubject('WORKFLOW_VERSION'),
      number: v ? `${v.code} ฉบับ ${v.versionNo}` : null,
      title: (v && withdrawalPending(v) ? v.withdrawalReason : v?.changeReason) ?? null,
      changeKind: null,
      poId: null,
      ownerMemberId: owner,
      conflictMemberIds: owner ? [owner] : [],
      chargedDepartmentId: v?.submittedBy?.primaryDepartmentId ?? root?.id ?? null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.documentType, title: facts.title }),
  href: (facts) => `/admin/workflows/${facts.id}`,
  async decide(tx, ctx, task, decision) {
    const id = task.step.route.subjectId
    const v = await tx.workflowVersion.findUniqueOrThrow({ where: { id }, select: { status: true, effectiveFrom: true, withdrawalRequestedAt: true } })
    if (withdrawalPending(v)) {
      const late = withdrawalTooLate(v, ctx.now)
      if (late) return late
      if (decision.outcome === 'APPROVED') return { ok: true, documentStatus: 'WITHDRAWN', ...(await withdrawApprovedVersion(tx, ctx, 'WORKFLOW_VERSION', id)) }
      return { ok: true, documentStatus: 'PUBLISHED', ...(await rejectWithdrawal(tx, 'WORKFLOW_VERSION', id, decision.reasonCommentId)) }
    }
    const approver = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (decision.outcome === 'APPROVED') {
      if (!approver) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member approves' } }
      const published = await publishApprovedWorkflowVersion(tx, ctx, task.step.route.subjectId, approver)
      return { ok: true, documentStatus: 'PUBLISHED', ...published }
    }
    const rejected = await rejectWorkflowVersion(tx, task.step.route.subjectId, decision.reasonCommentId)
    return { ok: true, documentStatus: 'REJECTED', ...rejected }
  },
  allowsRequestInfo: false,
  channels: { chatButton: () => false, emailLink: false, liff: false },
  // BR-WF-12: the submitter never approves their own version
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}
