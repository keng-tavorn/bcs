import { isAllowed, type Principal } from '@/server/authz'
import type { RequestAccessDto } from '@/server/queries/requests'
import type { TaskAccessDto } from '@/server/queries/tasks'

// Read permissions of the S2-12 pages (spec §2.4, BR-AUTH-05). Queries cannot import authz, so each page asks these
// before it reads a request or a task; the services check again on every action, so hiding a button is never the guard.

/** request.view: requester and followers (OWN), everyone who has or had a task on it (ASSIGNED), heads (DEPT), and ORG roles */
export function canViewRequest(principal: Principal, access: RequestAccessDto): boolean {
  return isAllowed(principal, 'request.view', {
    ownerMemberIds: [access.requesterMemberId, ...access.followerMemberIds],
    assigneeMemberIds: access.taskMemberIds,
    departmentId: access.chargedDepartmentId,
  })
}

/**
 * A DOA version opens on /admin/doa/<id>, which needs admin.doa.draft (ORG_ADMIN, §2.4). Everyone else sees the DOA
 * reference as text rather than a link that ends in a refusal; who else may read a version is an open question.
 */
export function canOpenDoaVersion(principal: Principal): boolean {
  return isAllowed(principal, 'admin.doa.draft')
}

/** /admin/org-authority lists authority changes for admin.orgAuthority.propose (ORG_ADMIN, §2.4) */
export function canOpenOrgAuthorityChanges(principal: Principal): boolean {
  return isAllowed(principal, 'admin.orgAuthority.propose')
}

/** What a member may do with a task page: decide it, look back at a task that was theirs, or nothing */
export type TaskRight = 'DECIDE' | 'VIEW' | 'NONE'

/**
 * An open task: whoever may decide it now — approval.decide comes only from the task itself, its assignee or the
 * delegator a delegate holds it for (BR-DLG-04). A task that has ended: the people who held or decided it.
 */
export function taskRight(principal: Principal, access: TaskAccessDto): TaskRight {
  const deciders = [access.assigneeMemberId, access.principalMemberId].filter((m): m is string => Boolean(m))
  const open = access.status === 'OPEN' || access.status === 'INFO_REQUESTED'
  if (open && isAllowed(principal, 'approval.decide', { deciderMemberIds: deciders })) return 'DECIDE'
  if (principal.kind === 'member' && [...deciders, access.decidedByMemberId].includes(principal.memberId)) return 'VIEW'
  return 'NONE'
}
