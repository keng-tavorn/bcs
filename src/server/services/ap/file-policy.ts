import { isAllowed, matchingGrants, type Principal, type ResourceScope } from '@/server/authz'
import type { TenantTx } from '@/server/db/tenant'
import { registerFileSubjectPolicy } from '../files/policies'
import { requireModule } from '../modules'

// Who may read a tier-2 invoice and download its file (FileLink subjectType Invoice): FINANCE who records invoices,
// whoever may reject one, and the members of a role an open difference of the invoice is sent to (BR-MATCH-09) — a
// RECEIVER within their grant's scope only: a department that asked for the PO's goods (DEPT), or one who received
// them (ASSIGNED), as gr.post scopes them. With module PAY off nobody reads one (BR-AP-13). Registered when the files
// service loads (../files/index.ts), so every page that links the file can open it.

/** Whether the member may settle the invoice's open differences: a role they are sent to, within the grant's scope */
export function resolvesInvoice(principal: Principal, openRoles: ReadonlySet<string>, scopes: readonly ResourceScope[]): boolean {
  if (principal.kind !== 'member') return false
  return scopes.some((scope) => matchingGrants(principal, 'invoice.exception.resolve', scope).some((g) => g.grantee.kind === 'ROLE' && openRoles.has(g.grantee.role)))
}

export function mayReadInvoice(principal: Principal, openRoles: ReadonlySet<string>, scopes: readonly ResourceScope[]): boolean {
  if (principal.kind !== 'member') return false
  if (isAllowed(principal, 'invoice.record') || isAllowed(principal, 'invoice.reject')) return true
  return resolvesInvoice(principal, openRoles, scopes)
}

/** The roles the invoice's open differences are sent to */
export async function openRolesOf(tx: TenantTx, invoiceId: string): Promise<Set<string>> {
  const open = await tx.matchException.findMany({ where: { invoiceId, status: 'OPEN' }, select: { assigneeRole: true } })
  return new Set(open.map((e) => e.assigneeRole))
}

/** The invoice as a resource: each department that asked for its PO's goods, with who received them (ASSIGNED) */
export async function invoiceScopes(tx: TenantTx, poId: string): Promise<ResourceScope[]> {
  const [requests, receipts] = await Promise.all([
    tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId } } } } } }, select: { requesterDepartmentId: true } }),
    tx.goodsReceipt.findMany({ where: { poId }, select: { receiverMemberId: true } }),
  ])
  const assigneeMemberIds = [...new Set(receipts.map((r) => r.receiverMemberId))]
  const departments = [...new Set(requests.map((r) => r.requesterDepartmentId))]
  return departments.length ? departments.map((departmentId) => ({ departmentId, assigneeMemberIds })) : [{ departmentId: null, assigneeMemberIds }]
}

registerFileSubjectPolicy('Invoice', async (tx, ctx, principal, invoiceId) => {
  const invoice = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { poId: true } })
  if (!invoice) return false
  if (!(await requireModule(ctx, 'PAY', tx)).ok) return false
  return mayReadInvoice(principal, await openRolesOf(tx, invoiceId), await invoiceScopes(tx, invoice.poId))
})
