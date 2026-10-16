import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { printablePurchaseOrder, printableRequest, type PrintableDocument } from '@/server/pdf/printable'
import { renderPdf } from '@/server/pdf/render'
import { verifyUrlOf } from './verification'

// The printed PR and PO (spec FR-PLT-009 AC1 AC2): rendered on demand from the document as it stands, for whoever may
// see it — request.view and po.view with their scopes (§2.4). Reading and rendering only; a download changes nothing.
// The PO that went to the supplier is also kept as a file (FileLink PO_PDF, FR-P2P-005).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface PdfFile {
  readonly fileName: string
  readonly pdf: Uint8Array
}

export async function requestPdf(ctx: Ctx, requestId: string): Promise<Result<PdfFile>> {
  const document = await requestPrintable(ctx, requestId)
  if (!document.ok) return document
  return ok({ fileName: `${document.data.number}.pdf`, pdf: await renderPdf(document.data) })
}

/** What the PR's PDF prints, for whoever may view the request (the QR of S6-19 included); reading only */
export async function requestPrintable(ctx: Ctx, requestId: string): Promise<Result<PrintableDocument>> {
  if (!UUID.test(requestId)) return err('NOT_FOUND', 'request not found')
  const db = forTenant(ctx.organizationId)
  const document = await db.$transaction(async (tx) => {
    const request = await tx.request.findUnique({ where: { id: requestId }, select: { id: true, requesterMemberId: true, chargedDepartmentId: true, followers: { select: { memberId: true } } } })
    if (!request) return err('NOT_FOUND', 'request not found')
    const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'REQUEST', subjectId: request.id } } }, select: { assigneeMemberId: true, principalMemberId: true } })
    const allowed = await authorize(tx, ctx, 'request.view', {
      ownerMemberIds: [request.requesterMemberId, ...request.followers.map((f) => f.memberId)],
      assigneeMemberIds: tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => Boolean(m)),
      departmentId: request.chargedDepartmentId,
    })
    if (!allowed.ok) return allowed
    // S6-19: the QR of the latest verification row (read only: a download never issues one)
    return ok({ ...(await printableRequest(tx, ctx.organizationId, request.id, ctx.now)), verifyUrl: await verifyUrlOf(tx, { subjectType: 'REQUEST', subjectId: request.id }) })
  })
  return document
}

export async function purchaseOrderPdf(ctx: Ctx, poId: string): Promise<Result<PdfFile>> {
  const document = await purchaseOrderPrintable(ctx, poId)
  if (!document.ok) return document
  return ok({ fileName: `${document.data.number}.pdf`, pdf: await renderPdf(document.data) })
}

/** What the PO's PDF prints, for whoever may view the PO (the QR of S6-19 included); reading only */
export async function purchaseOrderPrintable(ctx: Ctx, poId: string): Promise<Result<PrintableDocument>> {
  if (!UUID.test(poId)) return err('NOT_FOUND', 'purchase order not found')
  const db = forTenant(ctx.organizationId)
  const document = await db.$transaction(async (tx) => {
    const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, select: { id: true, createdById: true } })
    if (!po) return err('NOT_FOUND', 'purchase order not found')
    // OWN: who sent it for approval and the requesters of its PRs; ASSIGNED: its approvers
    const requesters = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { requesterMemberId: true } })
    const tasks = await tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'PURCHASE_ORDER', subjectId: po.id } } }, select: { assigneeMemberId: true, principalMemberId: true } })
    const allowed = await authorize(tx, ctx, 'po.view', {
      ownerMemberIds: [...(po.createdById ? [po.createdById] : []), ...requesters.map((r) => r.requesterMemberId)],
      assigneeMemberIds: tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => Boolean(m)),
    })
    if (!allowed.ok) return allowed
    return ok({ ...(await printablePurchaseOrder(tx, ctx.organizationId, po.id, ctx.now)), verifyUrl: await verifyUrlOf(tx, { subjectType: 'PURCHASE_ORDER', subjectId: po.id }) })
  })
  return document
}
