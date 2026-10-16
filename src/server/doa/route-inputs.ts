import type { RouteInput } from '@/core/doa'
import { vatFromNet } from '@/core/money/math'
import type { TenantTx } from '@/server/db/tenant'

// The input the DOA engine routed a stored document with (spec §7.4): read again from the document and its lines, with
// the time given — KPI G-2 (a) checks a decision against it; the 90-day backtest of a draft (S6-07 · BR-WF-13) routes
// it again under the draft. Requests, purchase orders and goods receipt variances; null for anything else.

/** The DOA engine's input for a routed document, as it stood when the route was made (KPI G-2 (a), the backtest) */
export async function routeInputOf(tx: TenantTx, subjectType: string, subjectId: string, at: Date): Promise<RouteInput | null> {
  if (subjectType === 'REQUEST') {
    const r = await tx.request.findUnique({ where: { id: subjectId } })
    if (!r) return null
    return { documentType: 'PURCHASE_REQUEST', amount: { netSatang: r.netSatang, vatSatang: r.vatSatang }, requesterMemberId: r.requesterMemberId, chargedDepartmentId: r.chargedDepartmentId, conflictMemberIds: [r.requesterMemberId], at }
  }
  if (subjectType === 'PURCHASE_ORDER') {
    const po = await tx.purchaseOrder.findUnique({ where: { id: subjectId }, include: { lines: { take: 1, orderBy: { lineNo: 'asc' }, include: { budgetLine: { select: { departmentId: true } } } } } })
    if (!po?.createdById || !po.lines[0]) return null
    const requesters = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { requesterMemberId: true } })
    return {
      documentType: 'PURCHASE_ORDER',
      amount: { netSatang: po.netSatang, vatSatang: po.vatSatang },
      requesterMemberId: po.createdById,
      chargedDepartmentId: po.lines[0].budgetLine.departmentId,
      conflictMemberIds: [...new Set([po.createdById, ...requesters.map((r) => r.requesterMemberId)])],
      at,
    }
  }
  if (subjectType === 'VARIANCE') {
    const v = await tx.variance.findUnique({ where: { id: subjectId }, include: { poLine: { include: { budgetLine: { select: { departmentId: true } } } }, po: { select: { vatRateBp: true } } } })
    if (!v) return null
    // the same amount the route was made with: the variance before VAT and its VAT at the PO's rate
    return { documentType: 'GR_VARIANCE', amount: { netSatang: v.amountSatang, vatSatang: vatFromNet(v.amountSatang, v.po.vatRateBp ?? 0).vat }, requesterMemberId: v.createdById, chargedDepartmentId: v.poLine.budgetLine.departmentId, conflictMemberIds: [v.createdById], at }
  }
  return null
}
