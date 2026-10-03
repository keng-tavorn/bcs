import { loadPrincipal, matchingGrants } from '@/server/authz'
import { makeCtx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'

/**
 * The members who receive goods for any of these departments as RECEIVER (§2.4 gr.post with DEPT scope): active RECEIVERs
 * whose departments, read the way authorization reads them (the role's scope or the member's own department), include
 * one of them. Read only; posting a receipt checks again, together with BR-SOD-02. Ordered by member id.
 */
export async function departmentReceivers(tx: TenantTx, organizationId: string, departmentIds: readonly string[], now: Date): Promise<string[]> {
  if (departmentIds.length === 0) return []
  const holders = await tx.roleAssignment.findMany({
    where: { role: 'RECEIVER', revokedAt: null, member: { status: 'ACTIVE' } },
    select: { memberId: true },
    distinct: ['memberId'],
    orderBy: { memberId: 'asc' },
  })
  const receivers: string[] = []
  for (const { memberId } of holders) {
    const principal = await loadPrincipal(tx, makeCtx({ organizationId, actor: { type: 'USER', memberId }, channel: 'SYSTEM', now }))
    if (departmentIds.some((departmentId) => matchingGrants(principal, 'gr.post', { departmentId }).some((g) => g.grantee.kind === 'ROLE'))) receivers.push(memberId)
  }
  return receivers
}
