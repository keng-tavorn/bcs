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

/** Who the edit page refuses (EditRefusal) */
export type EditRefused = 'REQUESTER' | 'VIEWER' | 'NONE'

/**
 * Why the edit page refuses a member its form (request.create on the request: only its requester edits it, and only
 * while their account may), and so what the page says and offers (§9.9 rule 7) — never a guess at whether the reader
 * may look at the request: the requester whose account may no longer edit (REQUESTER), someone else who may open the
 * request (VIEWER), or someone who may not even open it (NONE). `canOpen`: the request's page shows it to them (the same
 * check as that page, canViewRequest), so the edit page links to it only then, never to a page that refuses them again.
 */
export function editRefusal(principal: Principal, access: RequestAccessDto): { readonly who: EditRefused; readonly canOpen: boolean } {
  const canOpen = canViewRequest(principal, access)
  const requester = principal.kind === 'member' && principal.memberId === access.requesterMemberId
  return { who: requester ? 'REQUESTER' : canOpen ? 'VIEWER' : 'NONE', canOpen }
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
