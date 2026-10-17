import { holdMore, releaseHold } from '@/core/budget'
import { lineNet, parseQuantity, vatFromNet } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { checkSod, type SodPolicy } from '@/core/sod'
import { PO_MACHINE, VARIANCE_MACHINE, transition, type PoState, type TaskState, type VarianceState } from '@/core/state-machines'
import { systemClock } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { DECISION_STEP_UP_METHODS, requireStepUp } from '@/server/auth/step-up'
import { loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { applyBudget } from '@/server/budget/ledger'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { CommandOutcome } from '../_pipeline'
import { assignNextStep } from '../approvals/next-step'
import { closeRoute } from '../approvals/route'
import { completeStep, decidedEvent } from '../approvals/step-complete'
import { budgetRefusalFor } from '../purchase-orders/budget'
import { closePoInTx, hasOpenChange, unsettledLines } from '../purchase-orders/close'
import type { DocumentTask } from '../purchase-orders/decide'
import { keepPendingByLine, shortNow, standingOf } from './standing'

// Deciding a variance (spec BR-GR-03, BR-GR-04, FR-P2P-007 AC2 AC3, GC-DOA-18): the approver of the GR_VARIANCE rule
// approves or rejects — a variance is not returned. Who recorded it does not decide it (BR-SOD-01). A variance whose
// amount the DOA counted is at or above the version's stepUpThreshold is approved or rejected only with the actor's PIN
// step-up for it, used once (FR-AUTH-005 AC2). Approved:
// ACCEPT_EXCESS keeps the excess and holds more at the PO price; ACCEPT_DAMAGED keeps the damaged goods; CLOSE_SHORT
// gives back what still has not come when it is approved (BR-GR-04, NEW-32: goods received while it waited are not
// given up), counts it as cancelled on the line, and once nothing on the PO is short or waiting, closes the PO
// (GC-GR-04). Rejected: the excess or the damaged goods go back; a close-short is not done. The first decision on a step
// decides it: its other open tasks are cancelled with it (step-complete.ts, BR-SLA-04, NEW-47). An excess the budget line
// cannot hold is refused with BUDGET_INSUFFICIENT; what is left on the line and what is missing are told only to an
// approver who may view the line (§2.4 budget.view), the same rule as for a receipt (services/receiving).

const scaled = (d: { toString(): string }) => parseQuantity(d.toString())
const COMMAND = { APPROVE: 'variance.final_approval', REJECT: 'approval.reject' } as const

export async function decideVarianceTask(
  tx: TenantTx,
  ctx: Ctx,
  task: DocumentTask,
  input: { readonly decision: 'APPROVE' | 'RETURN' | 'REJECT'; readonly reason?: string | undefined },
  taskTo: TaskState,
): Promise<CommandOutcome<{ taskId: string; documentStatus: string }>> {
  const route = task.step.route
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member decides' } }
  const variance = await tx.variance.findFirst({ where: { id: route.subjectId } })
  if (!variance) return { ok: false, error: { code: 'NOT_FOUND', message: 'variance not found' } }
  // The PO is the aggregate that changes: locked before anything of it moves
  await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [variance.poId])
  if (input.decision === 'RETURN') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'a variance is approved or rejected, not returned', details: { from: variance.status, command: 'approval.return' } } }

  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { sodPolicy: true, stepUpThresholdSatang: true } })
  for (const who of [actor, task.principalMemberId].filter((m): m is string => Boolean(m))) {
    const sod = checkSod({ kind: 'DECIDE_APPROVAL', subject: 'VARIANCE', actorMemberId: who, requesterMemberIds: [variance.createdById] }, version.sodPolicy as unknown as SodPolicy)
    if (!sod.ok) {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
        auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: variance.id, data: { rule: sod.rule, action: input.decision, subjectType: 'VARIANCE', subjectId: variance.id, actorMemberId: actor } }],
      }
    }
  }
  // FR-AUTH-005 AC2: at or above the version's stepUpThreshold, approving and rejecting take the actor's PIN grant for
  // this variance (security clock), used once; a refusal rolls the use back with the rest
  const stepUp = await requireStepUp(
    tx,
    { memberId: actor, route: { subjectType: 'VARIANCE', subjectId: variance.id, amountSatang: route.amountSatang, stepUpThresholdSatang: version.stepUpThresholdSatang }, methods: DECISION_STEP_UP_METHODS },
    systemClock.now(),
  )
  if (!stepUp.ok) return { ok: false, error: stepUp.error }

  let reasonCommentId: string | null = null
  if (input.decision === 'REJECT') {
    reasonCommentId = newId()
    await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'Variance', subjectId: variance.id, authorMemberId: actor, body: input.reason! } })
  }
  await tx.approvalTask.update({
    where: { id: task.id },
    data: { status: taskTo, decision: input.decision, decidedAt: ctx.now, decidedByMemberId: actor, channel: ctx.channel, reason: input.reason ?? null, version: { increment: 1 } },
  })
  const events: EventDraft[] = [
    decidedEvent(ctx, { task, route, subjectType: 'VARIANCE', subjectId: variance.id, decision: input.decision, actorMemberId: actor, reasonCommentId, stepUpGrantId: stepUp.grantId }),
  ]
  // BR-SLA-04, FR-DOA-004 AC6: the step is decided — its other open tasks are cancelled — and the variance moves by what
  // the step came to, not by this task's decision
  const step = await completeStep(tx, ctx, task, input.decision)
  if (!step.ok) return { ok: false, error: step.error }
  events.push(...step.data.events)
  const outcome = step.data.outcome
  if (outcome === 'OPEN') return { ok: true, result: { taskId: task.id, documentStatus: variance.status }, events }
  // A variance is approved or rejected, never returned: refused above for the task, and a step cannot come to it either
  if (outcome === 'RETURNED') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'a variance is approved or rejected, not returned', details: { from: variance.status, command: 'approval.return' } } }
  const final = outcome === 'APPROVED' ? 'APPROVE' : 'REJECT'
  const line = await tx.poLine.findUniqueOrThrow({ where: { id: variance.poLineId } })

  if (outcome === 'APPROVED') {
    const departmentId = (await tx.budgetLine.findUniqueOrThrow({ where: { id: line.budgetLineId }, select: { departmentId: true } })).departmentId
    const next = await assignNextStep(
      tx,
      ctx,
      route,
      { type: 'VARIANCE', id: variance.id, label: line.description },
      // the amount the route was made with (routeVariance): before VAT plus its VAT at the PO's rate
      { documentType: 'GR_VARIANCE', amount: { netSatang: variance.amountSatang, vatSatang: vatFromNet(variance.amountSatang, (await tx.purchaseOrder.findUniqueOrThrow({ where: { id: variance.poId }, select: { vatRateBp: true } })).vatRateBp ?? 0).vat }, requesterMemberId: variance.createdById, chargedDepartmentId: departmentId, conflictMemberIds: [variance.createdById], at: route.createdAt },
    )
    if (!next.ok) return { ok: false, error: next.error }
    if (next.assigned) return { ok: true, result: { taskId: task.id, documentStatus: variance.status }, events: [...events, ...next.events], notifications: next.notifications }
  }

  const moved = transition(VARIANCE_MACHINE, variance.status as VarianceState, COMMAND[final])
  if (!moved.ok) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `${COMMAND[final]} is not allowed from ${variance.status}`, details: { from: variance.status, command: COMMAND[final] } } }
  events.push(...(await closeRoute(tx, { type: 'VARIANCE', id: variance.id }, outcome === 'APPROVED' ? 'COMPLETED' : 'CANCELLED', 'DOCUMENT_DECIDED')))
  await tx.variance.update({ where: { id: variance.id }, data: { status: moved.to, decidedAt: ctx.now, version: { increment: 1 } } })
  if (outcome === 'REJECTED') {
    events.push({ type: 'variance.rejected', aggregateType: 'Variance', aggregateId: variance.id, data: { taskId: task.id, reasonCommentId: reasonCommentId! } })
    return { ok: true, result: { taskId: task.id, documentStatus: moved.to }, events }
  }

  events.push({ type: 'variance.approved', aggregateType: 'Variance', aggregateId: variance.id, data: { routeId: route.id, doaVersionId: route.doaVersionId, doaRuleCode: route.ruleCode, disposition: variance.disposition } })
  const quantity = scaled(variance.quantity)
  const document = { type: 'PURCHASE_ORDER' as const, id: variance.poId }
  if (variance.disposition === 'ACCEPT_EXCESS') {
    // BR-GR-04: the excess is kept and held at the PO price; what is left and missing only for an approver who may view
    // the budget line (§2.4 budget.view)
    const budget = await applyBudget(tx, ctx, [{ budgetLineId: line.budgetLineId, document, run: (s) => holdMore(s, line.id, variance.amountSatang) }])
    if (!budget.ok) return { ok: false, error: await budgetRefusalFor(tx, await loadPrincipal(tx, ctx), budget.error, [line.budgetLineId]) }
    events.push(...budget.events)
    await tx.poLine.update({ where: { id: line.id }, data: { receivedQuantity: formatQuantity(scaled(line.receivedQuantity) + quantity), acceptedExtraQuantity: formatQuantity(scaled(line.acceptedExtraQuantity) + quantity) } })
  } else if (variance.disposition === 'ACCEPT_DAMAGED') {
    await tx.poLine.update({ where: { id: line.id }, data: { receivedQuantity: formatQuantity(scaled(line.receivedQuantity) + quantity) } })
  } else if (variance.disposition === 'CLOSE_SHORT') {
    // BR-GR-04, BR-BUD-06, NEW-32: what never came goes back and counts as cancelled on the line — counted again now,
    // because goods may have been received while the request waited, and damaged goods waiting to be kept may still be
    // kept. Never more than the approver approved; nothing at all when everything came.
    const keepPending = (await keepPendingByLine(tx, [line.id])).get(line.id) ?? 0n
    const missing = shortNow(standingOf(line, keepPending), line.unitPriceSatang)
    const giveUp = missing.quantity < quantity ? missing.quantity : quantity
    if (giveUp > 0n) {
      // the same rounding as the request (quantity × PO price, once): the approved amount when nothing came meanwhile
      const amount = giveUp === quantity ? variance.amountSatang : lineNet(formatQuantity(giveUp), line.unitPriceSatang)
      const budget = await applyBudget(tx, ctx, [{ budgetLineId: line.budgetLineId, document, run: (s) => releaseHold(s, line.id, amount) }])
      if (!budget.ok) return budget
      events.push(...budget.events)
      await tx.poLine.update({ where: { id: line.id }, data: { cancelledQuantity: formatQuantity(scaled(line.cancelledQuantity) + giveUp) } })
    }
  }

  // The PO moves on: received in full by an accepted variance, or closed once nothing is short or waiting (GC-GR-04)
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: variance.poId }, select: { id: true, status: true } })
  const short = (await unsettledLines(tx, po.id)).length
  const waiting = await tx.variance.count({ where: { poId: po.id, disposition: 'CLOSE_SHORT', status: 'PENDING_APPROVAL' } })
  // A PO with a change not finished stays open: PROCUREMENT closes it once the change is done (hasOpenChange)
  if (variance.disposition === 'CLOSE_SHORT' && short === 0 && waiting === 0 && !(await hasOpenChange(tx, po.id))) {
    const closed = await closePoInTx(tx, ctx, po, 'CLOSE_SHORT')
    if (!closed.ok) return closed
    events.push(...closed.events)
  } else if (short === 0 && po.status === 'PARTIALLY_RECEIVED') {
    const received = transition(PO_MACHINE, po.status as PoState, 'gr.posted_fully')
    if (received.ok) await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: received.to, version: { increment: 1 } } })
  }
  return { ok: true, result: { taskId: task.id, documentStatus: moved.to }, events }
}
