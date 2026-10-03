import { resolveRoute, type RouteInput } from '@/core/doa'
import type { AppError } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { taskTimes, type ApprovalSubject } from './route'

// The next step of a route after one is approved (spec §7.4, tier 1 SEQUENTIAL with one approver per step): its
// approver is the one the engine chose when the route was made, resolved again with the route's own time and input.

/** How soon before the due time the assignee is reminded, as a share of the SLA (DoaVersion.escalationPolicy, OQ-35) */
const DEFAULT_REMIND_PCT = 0.5

export type NextStep = { ok: true; assigned: false } | { ok: true; assigned: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }

export async function assignNextStep(
  tx: TenantTx,
  ctx: Ctx,
  route: { readonly id: string; readonly createdAt: Date; readonly doaVersionId: string },
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string },
  input: RouteInput,
): Promise<NextStep> {
  const next = await tx.approvalStep.findFirst({ where: { routeId: route.id, status: 'WAITING' }, orderBy: { stepNo: 'asc' } })
  if (!next) return { ok: true, assigned: false }
  const again = resolveRoute({ ...input, at: route.createdAt }, await loadRoutePolicy(tx))
  const step = again.ok ? again.data.steps.find((s) => s.stepNo === next.stepNo) : undefined
  if (!step) return { ok: false, error: { code: 'APPROVER_NOT_FOUND', message: 'the next step has no approver', details: { stepNo: next.stepNo } } }
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { escalationPolicy: true } })
  const remindPct = Number((version.escalationPolicy as { remindPct?: unknown } | null)?.remindPct ?? DEFAULT_REMIND_PCT)
  const times = taskTimes(ctx.now, next.slaBusinessMinutes, remindPct, await loadBusinessCalendar(tx, ctx.organizationId))
  const created = await tx.approvalTask.create({
    data: { organizationId: ctx.organizationId, stepId: next.id, assigneeMemberId: step.assigneeMemberId, principalMemberId: step.principalMemberId, resolvedFrom: step.resolvedFrom, assignedAt: ctx.now, dueAt: times.dueAt, remindAt: times.remindAt },
    select: { id: true },
  })
  await tx.approvalStep.update({ where: { id: next.id }, data: { status: 'ACTIVE' } })
  return {
    ok: true,
    assigned: true,
    events: [
      {
        type: 'approval_task.assigned',
        aggregateType: 'ApprovalTask',
        aggregateId: created.id,
        data: { subjectType: subject.type, subjectId: subject.id, routeId: route.id, stepNo: next.stepNo, assigneeMemberId: step.assigneeMemberId, principalMemberId: step.principalMemberId, resolvedFrom: step.resolvedFrom, dueAt: times.dueAt.toISOString() },
      },
    ],
    notifications: [
      {
        recipientMemberId: step.assigneeMemberId,
        templateKey: 'task.assigned',
        data: { subjectType: subject.type, subjectId: subject.id, label: subject.label, taskId: created.id, dueAt: times.dueAt.toISOString() },
        urgency: 'IMMEDIATE',
        dedupeKey: `task.assigned:${created.id}`,
        subjectType: subject.type,
        subjectId: subject.id,
      },
    ],
  }
}
