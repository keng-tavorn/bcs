import type { RouteInput, RouteStep } from '@/core/doa'
import type { AppError } from '@/core/result'
import { activateStep, stepOfRoute } from '@/core/workflow'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { assignStepTasks, remindShareOf, type ApprovalSubject } from './route'

// The next step of a route after one is approved (spec §7.4, BR-WF-14 · OQ-111 way ก · S6-08): its approvers — one, or a
// committee's slots — come from the rule and the DOA version the route was made with, but from the holders, the
// departments and the delegations as they are when the step starts (activateStep of src/core/workflow), starting from
// the route's own rule, not the one its amount chooses today. A holder who is the requester or conflicts with the
// document escalates as at the submit, in that same version. The stored step is matched to the engine's by its DOA step
// number (ApprovalStep.doaStepNo, BR-WF-06): its place in the rule before repeated approvers merged (RouteStep.
// ruleStepNo), never its place in the route — the holders of now may merge differently from those of the submit, and a
// route with a REVIEW step (S6) numbers its DOA steps one further on. When the step goes to someone else than the route
// would have given it when it was made, approval_task.assigned says whom it was to go to (holderChangedFrom), and the
// screens say the holder changed.

export type NextStep = { ok: true; assigned: false } | { ok: true; assigned: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }

/** Who holds each slot of a step: a committee's slot holders, or the one approver as slot 1 */
const holdersOf = (step: RouteStep | undefined): Map<number, string> =>
  new Map(step ? (step.committee ? step.committee.slots.map((s) => [s.slotNo, s.assigneeMemberId] as const) : [[1, step.assigneeMemberId] as const]) : [])

export async function assignNextStep(
  tx: TenantTx,
  ctx: Ctx,
  route: { readonly id: string; readonly createdAt: Date; readonly doaVersionId: string; readonly ruleCode: string },
  subject: { readonly type: ApprovalSubject; readonly id: string; readonly label: string; readonly number?: string | null },
  input: RouteInput,
): Promise<NextStep> {
  const next = await tx.approvalStep.findFirst({ where: { routeId: route.id, status: 'WAITING' }, orderBy: { stepNo: 'asc' } })
  if (!next) return { ok: true, assigned: false }
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, include: { rules: true } })
  const policy = await loadRoutePolicy(tx)
  const pinned = versionSnapshotFromRows(version, version.rules)
  const doaStepNo = next.doaStepNo
  // A holder of now who is the requester or conflicts escalates the rule (BR-DOA-06): the rule above may have fewer steps,
  // and its last step takes the waiting one (stepOfRoute)
  const now = doaStepNo === null ? null : activateStep(input, pinned, policy.org, policy.delegations, ctx.now, route.ruleCode)
  const step = now?.ok && doaStepNo !== null ? stepOfRoute(now.data, route.ruleCode, doaStepNo) : undefined
  if (!step) return { ok: false, error: { code: 'APPROVER_NOT_FOUND', message: 'the next step has no approver', details: { stepNo: next.stepNo, doaStepNo: next.doaStepNo } } }
  // Whom the route would have given the step when it was made: told apart from whom it goes to now
  const then = activateStep(input, pinned, policy.org, policy.delegations, route.createdAt, route.ruleCode)
  const before = holdersOf(then.ok ? stepOfRoute(then.data, route.ruleCode, doaStepNo!) : undefined)
  const timing = { remindShare: remindShareOf(version.escalationPolicy), calendar: await loadBusinessCalendar(tx, ctx.organizationId) }
  // Every slot of a committee step gets its task at once (BR-WF-01); a step of one approver gets one
  const assigned = await assignStepTasks(tx, ctx, { stepId: next.id, stepNo: next.stepNo, routeId: route.id, slaBusinessMinutes: next.slaBusinessMinutes }, step, subject, timing)
  await tx.approvalStep.update({ where: { id: next.id }, data: { status: 'ACTIVE' } })
  const events = assigned.events.map((e) => {
    if (e.type !== 'approval_task.assigned') return e
    const data = e.data as { slotNo?: number; assigneeMemberId: string }
    const was = before.get(data.slotNo ?? 1)
    return was && was !== data.assigneeMemberId ? { ...e, data: { ...e.data, holderChangedFrom: was } } : e
  })
  return { ok: true, assigned: true, events, notifications: assigned.notifications }
}
