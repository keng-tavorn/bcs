import { resolveRoute, type RouteInput, type RouteResult } from '@/core/doa'
import { err, ok, type Result } from '@/core/result'
import { addBusinessMinutes, remindAt, type BusinessCalendar } from '@/core/sla'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'

// Approval routes (spec §7.4, §6.2, BR-DOA-01..11): every submit or resubmit resolves a new route with the DOA engine
// and stores it as ApprovalRoute → ApprovalStep → ApprovalTask. An old route is never edited; a replaced route is
// CANCELLED. Tier 1 routes are SEQUENTIAL with one approver per step, so only the first step gets a task at once.

export type ApprovalSubject = 'REQUEST' | 'PURCHASE_ORDER' | 'VARIANCE' | 'DOA_VERSION' | 'ORG_AUTHORITY_CHANGE'

/** How soon before the due time the assignee is reminded, as a share of the SLA (DoaVersion.escalationPolicy, OQ-35) */
const DEFAULT_REMIND_PCT = 0.5

export interface StartedRoute {
  readonly route: RouteResult
  readonly routeId: string
  readonly firstTask: { readonly id: string; readonly assigneeMemberId: string; readonly principalMemberId: string | null; readonly dueAt: Date }
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
}

/** Times of a newly assigned task (BR-SLA-01..03): due after its SLA in business time, reminded part-way. */
export function taskTimes(assignedAt: Date, slaMinutes: number, remindPct: number, calendar: BusinessCalendar): { dueAt: Date; remindAt: Date } {
  return { dueAt: addBusinessMinutes(assignedAt, slaMinutes, calendar), remindAt: remindAt({ assignedAt, slaMinutes, remindPct }, calendar) }
}

/**
 * Resolves the route of a document and stores it with its first task, inside the caller's command transaction. A
 * refusal of the engine (DOA_NOT_CONFIGURED, APPROVER_NOT_FOUND, NO_HIGHER_AUTHORITY, …) comes back unchanged and
 * nothing is written.
 */
export async function startRoute(
  tx: TenantTx,
  ctx: Ctx,
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string },
  input: RouteInput,
): Promise<Result<StartedRoute>> {
  const policy = await loadRoutePolicy(tx)
  const resolved = resolveRoute(input, policy)
  if (!resolved.ok) return resolved
  return storeRoute(tx, ctx, subject, resolved.data)
}

/**
 * Stores a route with its first task: one the DOA engine resolved, or the initial package's route to the contract
 * signatory (BR-DOA-19), which no DOA can resolve because none is in effect yet.
 */
export async function storeRoute(
  tx: TenantTx,
  ctx: Ctx,
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string },
  route: RouteResult,
): Promise<Result<StartedRoute>> {
  if (route.steps.length === 0) return err('APPROVER_NOT_FOUND', 'the route has no approver', { ruleCode: route.ruleCode })

  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { escalationPolicy: true } })
  const remindPct = Number((version.escalationPolicy as { remindPct?: unknown } | null)?.remindPct ?? DEFAULT_REMIND_PCT)
  const calendar = await loadBusinessCalendar(tx, ctx.organizationId)

  // Replaced routes of the same document are cancelled with their open tasks (BR-DOA-09)
  const routeNo = (await tx.approvalRoute.count({ where: { subjectType: subject.type, subjectId: subject.id } })) + 1
  const created = await tx.approvalRoute.create({
    data: {
      organizationId: ctx.organizationId,
      subjectType: subject.type,
      subjectId: subject.id,
      routeNo,
      doaVersionId: route.doaVersionId,
      ruleCode: route.ruleCode,
      escalatedFromRuleCode: route.escalatedFromRuleCode,
      amountBasis: route.amountBasis,
      amountSatang: route.basisAmountSatang,
      explanationTh: route.explanationTh,
    },
    select: { id: true },
  })

  let first: StartedRoute['firstTask'] | null = null
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  for (const step of route.steps) {
    const isFirst: boolean = first === null
    const stepRow: { id: string } = await tx.approvalStep.create({
      data: { organizationId: ctx.organizationId, routeId: created.id, stepNo: step.stepNo, slaBusinessMinutes: step.slaBusinessMinutes, status: isFirst ? 'ACTIVE' : 'WAITING' },
      select: { id: true },
    })
    if (!isFirst) continue
    const times = taskTimes(ctx.now, step.slaBusinessMinutes, remindPct, calendar)
    const task: { id: string } = await tx.approvalTask.create({
      data: {
        organizationId: ctx.organizationId,
        stepId: stepRow.id,
        assigneeMemberId: step.assigneeMemberId,
        principalMemberId: step.principalMemberId,
        resolvedFrom: step.resolvedFrom,
        assignedAt: ctx.now,
        dueAt: times.dueAt,
        remindAt: times.remindAt,
      },
      select: { id: true },
    })
    first = { id: task.id, assigneeMemberId: step.assigneeMemberId, principalMemberId: step.principalMemberId, dueAt: times.dueAt }
    events.push({
      type: 'approval_task.assigned',
      aggregateType: 'ApprovalTask',
      aggregateId: task.id,
      data: {
        subjectType: subject.type,
        subjectId: subject.id,
        routeId: created.id,
        stepNo: step.stepNo,
        assigneeMemberId: step.assigneeMemberId,
        principalMemberId: step.principalMemberId,
        resolvedFrom: step.resolvedFrom,
        dueAt: times.dueAt.toISOString(),
      },
    })
    notifications.push({
      recipientMemberId: step.assigneeMemberId,
      templateKey: 'task.assigned',
      data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, taskId: task.id, dueAt: times.dueAt.toISOString() },
      urgency: 'IMMEDIATE',
      dedupeKey: `task.assigned:${task.id}`,
      subjectType: subject.type,
      subjectId: subject.id,
    })
    // BR-DLG-05: the delegate conflicts with the document, so the task stayed with the delegator; ORG_ADMIN is told
    if (step.notifyOrgAdmin) {
      const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
      for (const memberId of new Set(admins.map((a) => a.memberId))) {
        notifications.push({
          recipientMemberId: memberId,
          templateKey: 'approval_task.delegate_conflict',
          data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, taskId: task.id },
          urgency: 'IMMEDIATE',
          dedupeKey: `approval_task.delegate_conflict:${task.id}:${memberId}`,
          subjectType: subject.type,
          subjectId: subject.id,
        })
      }
    }
  }
  return ok({ route, routeId: created.id, firstTask: first!, events, notifications })
}

/** Cancels the open tasks and the active route of a document (cancel, resubmit, final decision). */
export async function closeRoute(
  tx: TenantTx,
  subject: { readonly type: ApprovalSubject; readonly id: string },
  routeStatus: 'COMPLETED' | 'CANCELLED',
  why: 'REQUEST_CANCELLED' | 'ROUTE_REPLACED' | 'DOCUMENT_DECIDED',
): Promise<EventDraft[]> {
  const routes = await tx.approvalRoute.findMany({ where: { subjectType: subject.type, subjectId: subject.id, status: 'ACTIVE' }, select: { id: true } })
  const events: EventDraft[] = []
  for (const route of routes) {
    const open = await tx.approvalTask.findMany({ where: { step: { routeId: route.id }, status: { in: ['OPEN', 'INFO_REQUESTED'] } }, select: { id: true } })
    for (const task of open) {
      await tx.approvalTask.update({ where: { id: task.id }, data: { status: 'CANCELLED' } })
      events.push({ type: 'approval_task.cancelled', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectId: subject.id, why } })
    }
    await tx.approvalStep.updateMany({ where: { routeId: route.id, status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: routeStatus === 'COMPLETED' ? 'DONE' : 'CANCELLED' } })
    await tx.approvalRoute.update({ where: { id: route.id }, data: { status: routeStatus } })
  }
  return events
}
