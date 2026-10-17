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

/**
 * The approvers of a step that starts at `at`: the route's version, the organization of now. ruleCode is the route's own
 * rule (BR-WF-14), not the one the amount would choose today: a route escalated at its submit keeps the band it was
 * escalated to. Left out, the amount chooses. Repeated approvers are not merged again (BR-DOA-07 merged them once, when
 * the route was made, and the stored steps are what is left): every step of the rule keeps its holder of now, so the
 * stored step finds its own (stepOfRoute).
 */
export function activateStep(input: RouteInput, version: DoaVersionSnapshot, org: OrgSnapshot, delegations: readonly DelegationSnapshot[], at: Date, ruleCode?: string): Result<RouteResult> {
  // The route's version as the only one, in effect whenever: its rules decide, not the version of today
  const pinned: DoaVersionSnapshot = { ...version, status: 'PUBLISHED', effectiveFrom: new Date(0), effectiveTo: null, collapseDuplicateApprovers: false }
  return resolveRoute({ ...input, at }, { versions: [pinned], org, delegations }, ruleCode === undefined ? {} : { ruleCode })
}

/**
 * The step of a route found again that stands for the stored step of DOA step number doaStepNo — its place in the rule
 * (RouteStep.ruleStepNo): that step, or, on a route found again with repeated approvers merged (resolveRoute, not
 * activateStep), the step it merged into, which has the same approver. A conflict that moved the route up a band (BR-DOA-06) gives the
 * waiting step to the last step of the band it moved to.
 */
export function stepOfRoute(route: RouteResult, ruleCode: string, doaStepNo: number): RouteResult['steps'][number] | undefined {
  return route.ruleCode !== ruleCode ? route.steps.at(-1) : route.steps.find((s) => s.ruleStepNo >= doaStepNo)
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
