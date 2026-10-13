import { isAllowed, matchingGrants, type Principal } from '@/server/authz'
import type { TenantTx } from '@/server/db/tenant'
import { registerFileSubjectPolicy } from '../files/policies'

// Who may read a tier-2 invoice and download its file (FileLink subjectType Invoice): FINANCE who records invoices,
// whoever may reject one, and the members of a role an open difference of the invoice is sent to (BR-MATCH-09).
// Registered when the files service loads (../files/index.ts), so every page that links the file can open it.

export function mayReadInvoice(principal: Principal, openRoles: ReadonlySet<string>): boolean {
  if (principal.kind !== 'member') return false
  if (isAllowed(principal, 'invoice.record') || isAllowed(principal, 'invoice.reject')) return true
  return matchingGrants(principal, 'invoice.exception.resolve').some((g) => g.grantee.kind === 'ROLE' && openRoles.has(g.grantee.role))
}

/** The roles the invoice's open differences are sent to */
export async function openRolesOf(tx: TenantTx, invoiceId: string): Promise<Set<string>> {
  const open = await tx.matchException.findMany({ where: { invoiceId, status: 'OPEN' }, select: { assigneeRole: true } })
  return new Set(open.map((e) => e.assigneeRole))
}

registerFileSubjectPolicy('Invoice', async (tx, _ctx, principal, invoiceId) => {
  if (!(await tx.invoice.count({ where: { id: invoiceId } }))) return false
  return mayReadInvoice(principal, await openRolesOf(tx, invoiceId))
})
