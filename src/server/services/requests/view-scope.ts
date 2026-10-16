import type { ResourceScope } from '@/server/authz'
import type { TenantTx } from '@/server/db/tenant'
import { requestTaskMemberIds } from '@/server/queries/requests'

// Who a request belongs to, for request.view (spec §2.3, §2.4): the requester and followers (OWN), everyone who has or
// had an approval task on it or on its over-budget approvals (S6-16), as assignee or as the person they act for
// (ASSIGNED), and the department that pays
// (DEPT). The services and the file download policy (FR-PLT-004 AC2) ask isAllowed() with this scope.

export async function requestViewScope(tx: TenantTx, requestId: string): Promise<ResourceScope | null> {
  const request = await tx.request.findFirst({
    where: { id: requestId },
    select: { requesterMemberId: true, chargedDepartmentId: true, followers: { select: { memberId: true } } },
  })
  if (!request) return null
  return {
    ownerMemberIds: [request.requesterMemberId, ...request.followers.map((f) => f.memberId)],
    assigneeMemberIds: await requestTaskMemberIds(tx, requestId),
    departmentId: request.chargedDepartmentId,
  }
}
