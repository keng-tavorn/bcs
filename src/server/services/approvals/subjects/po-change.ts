import { documentTypeOfSubject } from '@/core/doa'
import { decidePoChange } from '../../purchase-orders/change'
import type { SubjectAdapter } from './index'

// The PO_CHANGE approval subject (ADR-068, ADR-125, S8-10): a change of a sent PO's prices or quantities under DOA
// PO_CHANGE with the PO's new totals. Neither the PO's creator, the proposer nor a requester of its source requests
// decides it (BR-POC-02, BR-SOD-01, BR-SOD-03). The last approval applies the change under the PO's lock or refuses
// PO_CHANGE_BELOW_PROGRESS with the task still open (BR-POC-04); a return or a rejection gives the reservation back.

export const poChangeSubject: SubjectAdapter = {
  async facts(tx, id) {
    const change = await tx.poChange.findUniqueOrThrow({
      where: { id },
      select: { changeNo: true, poId: true, createdById: true, submittedById: true, po: { select: { number: true, createdById: true, lines: { orderBy: { lineNo: 'asc' }, take: 1, select: { budgetLine: { select: { departmentId: true } } } } } } },
    })
    const requesters = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: change.poId } } } } } }, select: { requesterMemberId: true } })
    const owner = change.submittedById ?? change.createdById
    return {
      type: 'PO_CHANGE',
      id,
      documentType: documentTypeOfSubject('PO_CHANGE'),
      number: change.po.number ? `${change.po.number} #${change.changeNo}` : null,
      title: change.po.number ? `แก้ไข PO ${change.po.number}` : null,
      changeKind: null,
      poId: change.poId,
      ownerMemberId: owner,
      conflictMemberIds: [...new Set([owner, change.createdById, ...(change.po.createdById ? [change.po.createdById] : []), ...requesters.map((r) => r.requesterMemberId)])],
      chargedDepartmentId: change.po.lines[0]?.budgetLine.departmentId ?? null,
    }
  },
  labels: (facts) => ({ label: facts.number ?? facts.documentType, title: facts.title }),
  href: (facts) => (facts.poId ? `/procurement/purchase-orders/${facts.poId}` : '/tasks'),
  decide: (tx, ctx, task, decision) => decidePoChange(tx, ctx, task.step.route.subjectId, decision),
  allowsRequestInfo: false,
  channels: { chatButton: () => true, emailLink: true, liff: true },
  sodContext: (facts) => ({ requesterMemberIds: facts.conflictMemberIds }),
}
