import { resolveRoute, type RouteInput } from '@/core/doa'
import type { AppError } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { assignStepTasks, remindShareOf, type ApprovalSubject } from './route'

// The next step of a route after one is approved (spec §7.4): its approvers — one, or a committee's slots — are the ones
// the engine chose when the route was made, resolved again with the route's own time and input. The stored step is
// matched to the engine's by its DOA step number (ApprovalStep.doaStepNo, BR-WF-06), never by its place in the route:
// a route with a REVIEW step (S6) numbers its DOA steps one further on. `holdersAt` is the moment the engine runs at:
// the route's time today (OQ-111 way ข); S6-08 moves it to the moment the step starts, with the route's version (way ก).

export type NextStep = { ok: true; assigned: false } | { ok: true; assigned: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }

export async function assignNextStep(
  tx: TenantTx,
  ctx: Ctx,
  route: { readonly id: string; readonly createdAt: Date; readonly doaVersionId: string },
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string },
  input: RouteInput,
  holdersAt: Date = route.createdAt,
): Promise<NextStep> {
  const next = await tx.approvalStep.findFirst({ where: { routeId: route.id, status: 'WAITING' }, orderBy: { stepNo: 'asc' } })
  if (!next) return { ok: true, assigned: false }
  const again = next.doaStepNo === null ? null : resolveRoute({ ...input, at: holdersAt }, await loadRoutePolicy(tx))
  const step = again?.ok ? again.data.steps.find((s) => s.stepNo === next.doaStepNo) : undefined
  if (!step) return { ok: false, error: { code: 'APPROVER_NOT_FOUND', message: 'the next step has no approver', details: { stepNo: next.stepNo, doaStepNo: next.doaStepNo } } }
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { escalationPolicy: true } })
  const timing = { remindShare: remindShareOf(version.escalationPolicy), calendar: await loadBusinessCalendar(tx, ctx.organizationId) }
  // Every slot of a committee step gets its task at once (BR-WF-01); a step of one approver gets one
  const assigned = await assignStepTasks(tx, ctx, { stepId: next.id, stepNo: next.stepNo, routeId: route.id, slaBusinessMinutes: next.slaBusinessMinutes }, step, subject, timing)
  await tx.approvalStep.update({ where: { id: next.id }, data: { status: 'ACTIVE' } })
  return { ok: true, assigned: true, events: assigned.events, notifications: assigned.notifications }
}
