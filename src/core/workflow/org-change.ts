import { resolveApprover } from '../doa/approvers'
import { resolveRoute } from '../doa'
import type { ApproverSpec, DelegationSnapshot, DoaVersionSnapshot, OrgSnapshot, RouteInput, RouteResult } from '../doa/types'
import type { Result } from '../result'
import { resolveReviewer, type ReviewerSpec } from './reviewers'

// Approval lines that follow the organization as it changes (spec §7.17 BR-WF-14 · FR-WF-104 · OQ-111 way ก). Pure: the
// organization after the change, the route's own DOA version and the time are parameters.
//   - activateStep: a WAITING step that starts now takes its approvers from the rule and version its route was made
//     with, but from the holders and the departments as they are now (GC-WF-45); a holder who is the requester or
//     conflicts with the document escalates as at the submit (BR-DOA-06), in that same version
//   - reresolveOpenTasks: after a department moved (DEPARTMENT_REPARENT), every open task whose approver depends on the
//     department tree is found again; one that now lands on someone else moves there (GC-WF-43); an organization-wide
//     position or a named member does not move (GC-WF-44); a task whose new holder is missing or conflicts with the
//     document stays where it is, for ORG_ADMIN to reassign (BR-DOA-17)

/** The approvers of a step that starts at `at`: the route's version, the organization of now */
export function activateStep(input: RouteInput, version: DoaVersionSnapshot, org: OrgSnapshot, delegations: readonly DelegationSnapshot[], at: Date): Result<RouteResult> {
  // The route's version as the only one, in effect whenever: its rules decide, not the version of today
  const pinned: DoaVersionSnapshot = { ...version, status: 'PUBLISHED', effectiveFrom: new Date(0), effectiveTo: null }
  return resolveRoute({ ...input, at }, { versions: [pinned], org, delegations })
}

export interface OpenTaskOnTree {
  readonly id: string
  /** e.g. "POSITION:VP@OPS" */
  readonly resolvedFrom: string
  /** The spec the task was found with: a DOA approver, or a reviewer of the workflow */
  readonly approver: ApproverSpec | ReviewerSpec
  readonly chargedDepartmentId: string
  readonly assigneeMemberId: string
  /** The delegator a delegate holds the task for (BR-DLG-04) */
  readonly principalMemberId: string | null
  readonly conflictMemberIds: readonly string[]
}

export interface Reresolved {
  readonly reassign: ReadonlyArray<{ readonly task: string; readonly to: string; readonly resolvedFrom: string }>
  /** Tasks left where they are: nobody holds the position now (NOT_FOUND), or the new holder conflicts (CONFLICT) */
  readonly stuck: ReadonlyArray<{ readonly task: string; readonly reason: 'NOT_FOUND' | 'CONFLICT' }>
}

export function reresolveOpenTasks(tasks: readonly OpenTaskOnTree[], org: OrgSnapshot, at: Date): Reresolved {
  const reassign: Array<Reresolved['reassign'][number]> = []
  const stuck: Array<Reresolved['stuck'][number]> = []
  for (const task of tasks) {
    const spec = task.approver
    let found: { memberId: string; resolvedFrom: string } | null
    if (spec.kind === 'POSITION_OF_DEPARTMENT') {
      const r = resolveApprover(spec, task.chargedDepartmentId, org, at)
      found = r.found ? { memberId: r.memberId, resolvedFrom: r.resolvedFrom } : null
    } else if (spec.kind === 'POSITION_AT') {
      found = resolveReviewer(spec, org, at)
    } else {
      // An organization-wide position or a named member does not depend on where a department sits
      continue
    }
    if (!found) {
      stuck.push({ task: task.id, reason: 'NOT_FOUND' })
      continue
    }
    const holder = task.principalMemberId ?? task.assigneeMemberId
    if (found.memberId === holder) continue
    if (task.conflictMemberIds.includes(found.memberId)) {
      stuck.push({ task: task.id, reason: 'CONFLICT' })
      continue
    }
    reassign.push({ task: task.id, to: found.memberId, resolvedFrom: found.resolvedFrom })
  }
  return { reassign, stuck }
}
