import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { approverRoles, departmentsOf, hiddenReviewReasons, routeOf, type DoaRefDto, type RouteSlotDto, type RouteStepDto } from './requests'

// getRouteView (S6-06 · spec docs/sub-specs/S6.md "ให้ขั้นอื่น"): a stored approval route step by step, for S13 (the
// Approval Brief is made for APPROVAL steps only) and S17 (the LIFF app and its cards). Each step says what kind it is —
// APPROVAL: a DOA step of one approver · REVIEW: the reviewers' step (ApprovalStep.kind REVIEW) · COMMITTEE: a DOA step of
// several slots — with its mode, quorum, groups (REVIEW), status and what it came to; each slot who holds it, the rules
// it answers for, its state, who decided it and for whom a delegate acted, when, and the reason of that decision as
// the reader may read it (a reviewer's reason: BR-WF-09). The caller has checked that the reader may see the document
// (as for getRequestView); this only narrows the reasons.

export type RouteStepType = NonNullable<RouteStepDto['stepType']>

export interface RouteViewSlotDto extends RouteSlotDto {
  /** The reason of the slot's decision; null when there is none or the reader may not read it (BR-WF-09) */
  readonly reason: string | null
}

export interface RouteViewStepDto {
  readonly stepNo: number
  readonly doaStepNo: number | null
  readonly stepType: RouteStepType
  readonly mode: 'SEQUENTIAL' | 'PARALLEL'
  readonly quorum: 'ALL' | 'ANY' | 'COUNT'
  readonly quorumCount: number | null
  readonly groups: NonNullable<RouteStepDto['groups']>
  readonly status: RouteStepDto['status']
  /** What the step came to; OPEN while it waits or runs, null when it closed with nothing decided */
  readonly outcome: 'OPEN' | 'APPROVED' | 'RETURNED' | 'REJECTED' | null
  readonly slots: readonly RouteViewSlotDto[]
}

export interface RouteViewDto {
  readonly id: string
  readonly subjectType: string
  readonly subjectId: string
  readonly routeNo: number
  readonly status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED'
  readonly doa: DoaRefDto
  /** The reviewer version of a route with a REVIEW step */
  readonly workflowVersion: { readonly id: string; readonly code: string; readonly versionNo: number } | null
  readonly steps: readonly RouteViewStepDto[]
}

const OUTCOME_OF = { APPROVE: 'APPROVED', RETURN: 'RETURNED', REJECT: 'REJECTED' } as const

export async function getRouteView(ctx: Ctx, routeId: string): Promise<RouteViewDto | null> {
  const db = forTenant(ctx.organizationId)
  const stored = await db.approvalRoute.findFirst({
    where: { id: routeId },
    select: { subjectType: true, subjectId: true, workflowVersion: { select: { id: true, code: true, versionNo: true } } },
  })
  if (!stored) return null
  const departments = await departmentsOf(db)
  const route = await routeOf(db, routeId, new Map(), await approverRoles(db, departments.byCode))
  if (!route) return null

  // Every task of the document, across its routes: a reviewer's reason is the requester's, the DOA approvers', AUDITOR's
  // and the slot's reviewers' to read (BR-WF-09)
  const tasks = await db.approvalTask.findMany({
    where: { step: { route: { subjectType: stored.subjectType, subjectId: stored.subjectId } } },
    select: { id: true, stepId: true, slotNo: true, assigneeMemberId: true, principalMemberId: true, reason: true, step: { select: { kind: true } } },
  })
  const requester = stored.subjectType === 'REQUEST' ? ((await db.request.findFirst({ where: { id: stored.subjectId }, select: { requesterMemberId: true } }))?.requesterMemberId ?? '') : ''
  const hidden = await hiddenReviewReasons(db, ctx, requester, tasks)
  const reasonOf = new Map(tasks.map((t) => [t.id, hidden.has(t.id) ? null : t.reason]))

  return {
    id: route.id,
    subjectType: stored.subjectType,
    subjectId: stored.subjectId,
    routeNo: route.routeNo,
    status: route.status,
    doa: route.doa,
    workflowVersion: stored.workflowVersion,
    steps: route.steps.map((s) => ({
      stepNo: s.stepNo,
      doaStepNo: s.doaStepNo ?? null,
      stepType: s.stepType ?? 'APPROVAL',
      mode: s.stepType === 'APPROVAL' ? 'SEQUENTIAL' : 'PARALLEL',
      quorum: s.quorum ?? 'ALL',
      quorumCount: s.quorumCount ?? null,
      groups: s.groups ?? [],
      status: s.status,
      outcome: s.decision ? OUTCOME_OF[s.decision] : s.status === 'ACTIVE' || s.status === 'WAITING' ? 'OPEN' : null,
      slots: (s.slots ?? []).map((slot) => ({ ...slot, reason: slot.decidedTaskId ? (reasonOf.get(slot.decidedTaskId) ?? null) : null })),
    })),
  }
}
