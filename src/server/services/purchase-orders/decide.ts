import { checkSod, type SodPolicy } from '@/core/sod'
import { PO_MACHINE, transition, type PoState, type TaskState } from '@/core/state-machines'
import { systemClock } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { DECISION_STEP_UP_METHODS, requireStepUp } from '@/server/auth/step-up'
import { loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import type { CommandOutcome } from '../_pipeline'
import { assignNextStep } from '../approvals/next-step'
import { closeRoute } from '../approvals/route'
import { completeStep, decidedEvent, FINAL_DECISION } from '../approvals/step-complete'
import { budgetRefusalFor, commitForPo, poBudgetLines, releasePoDelta } from './budget'
import { orderSourceLines } from './requests'

// Deciding a PO's approval task (spec §6.4 PO table, FR-P2P-004, BR-BUD-05, BR-SOD-01, BR-SOD-03): the assignee — or
// the delegator of a delegate — decides; at that moment neither the requesters of the PO's requests nor its creator
// may (checked again here, not only when the route was made). A PO whose amount the DOA counted is at or above the
// version's stepUpThreshold is decided — approved, returned or rejected — only with the actor's PIN step-up for it,
// used once (FR-AUTH-005 AC2). The last approval holds the budget and orders the request lines; a rejection or a return
// gives back the delta reserved at submit (a return leaves a draft to edit). The first decision on a step decides it:
// its other open tasks — the co-assignee of an escalated step — are cancelled with it (step-complete.ts, BR-SLA-04).
// A last approval the budget line cannot hold is refused with BUDGET_INSUFFICIENT; what is left on the line and what is
// missing are budget figures, told only to an approver who may view the line (§2.4 budget.view) — approving a PO gives
// no right to read its budget.

export interface DocumentTask {
  readonly id: string
  readonly stepId: string
  readonly principalMemberId: string | null
  readonly step: {
    readonly route: {
      readonly id: string
      readonly subjectId: string
      readonly doaVersionId: string
      readonly ruleCode: string
      readonly createdAt: Date
      /** The amount the DOA counted (its amountBasis), which the step-up threshold is compared with */
      readonly amountSatang: bigint | null
    }
  }
}

const COMMAND = { APPROVE: 'po.final_approval', RETURN: 'approval.return', REJECT: 'approval.reject' } as const

export async function decidePoTask(
  tx: TenantTx,
  ctx: Ctx,
  task: DocumentTask,
  input: { readonly decision: 'APPROVE' | 'RETURN' | 'REJECT'; readonly reason?: string | undefined },
  taskTo: TaskState,
): Promise<CommandOutcome<{ taskId: string; documentStatus: string }>> {
  const route = task.step.route
  const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member decides' } }
  const [locked] = await lockRowsForUpdate(tx, 'PurchaseOrder', ctx.organizationId, [route.subjectId])
  if (!locked) return { ok: false, error: { code: 'NOT_FOUND', message: 'purchase order not found' } }
  const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: route.subjectId }, include: { lines: { select: { budgetLineId: true } } } })
  const requests = await tx.request.findMany({ where: { lines: { some: { poSources: { some: { poLine: { poId: po.id } } } } } }, select: { id: true, requesterMemberId: true } })

  // BR-SOD-01, BR-SOD-03 at the moment of deciding, for the actor and for the delegator a delegate acts for
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { sodPolicy: true, stepUpThresholdSatang: true } })
  for (const who of [actor, task.principalMemberId].filter((m): m is string => Boolean(m))) {
    const sod = checkSod(
      { kind: 'DECIDE_APPROVAL', subject: 'PURCHASE_ORDER', actorMemberId: who, requesterMemberIds: requests.map((r) => r.requesterMemberId), poCreatorMemberId: po.createdById },
      version.sodPolicy as unknown as SodPolicy,
    )
    if (!sod.ok) {
      return {
        ok: false,
        error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
        auditEvents: [
          { type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: po.id, data: { rule: sod.rule, action: input.decision, subjectType: 'PURCHASE_ORDER', subjectId: po.id, actorMemberId: actor } },
        ],
      }
    }
  }
  // FR-AUTH-005 AC2: at or above the version's stepUpThreshold, every decision takes the actor's PIN grant for this PO
  // (security clock), used once; a refusal rolls the use back with the rest
  const stepUp = await requireStepUp(
    tx,
    { memberId: actor, route: { subjectType: 'PURCHASE_ORDER', subjectId: po.id, amountSatang: route.amountSatang, stepUpThresholdSatang: version.stepUpThresholdSatang }, methods: DECISION_STEP_UP_METHODS },
    systemClock.now(),
  )
  if (!stepUp.ok) return { ok: false, error: stepUp.error }

  let reasonCommentId: string | null = null
  if (input.decision !== 'APPROVE') {
    reasonCommentId = newId()
    await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'PurchaseOrder', subjectId: po.id, authorMemberId: actor, body: input.reason! } })
  }
  await tx.approvalTask.update({
    where: { id: task.id },
    data: { status: taskTo, decision: input.decision, decidedAt: ctx.now, decidedByMemberId: actor, channel: ctx.channel, reason: input.reason ?? null, version: { increment: 1 } },
  })
  const events: EventDraft[] = [
    decidedEvent(ctx, { task, route, subjectType: 'PURCHASE_ORDER', subjectId: po.id, decision: input.decision, actorMemberId: actor, reasonCommentId, stepUpGrantId: stepUp.grantId }),
  ]
  // BR-SLA-04, FR-DOA-004 AC6: the step is decided — its other open tasks are cancelled — and the PO moves by what the
  // step came to, not by this task's decision
  const step = await completeStep(tx, ctx, task, input.decision)
  if (!step.ok) return { ok: false, error: step.error }
  events.push(...step.data.events)
  const outcome = step.data.outcome
  const notifications: NotificationDraft[] = []
  if (outcome === 'OPEN') return { ok: true, result: { taskId: task.id, documentStatus: po.status }, events, notifications }
  const final = FINAL_DECISION[outcome]

  if (outcome === 'APPROVED') {
    const chargedDepartmentId = (await tx.budgetLine.findUniqueOrThrow({ where: { id: po.lines[0]!.budgetLineId }, select: { departmentId: true } })).departmentId
    const next = await assignNextStep(
      tx,
      ctx,
      route,
      { type: 'PURCHASE_ORDER', id: po.id, label: po.number ?? po.id },
      {
        documentType: 'PURCHASE_ORDER',
        amount: { netSatang: po.netSatang, vatSatang: po.vatSatang },
        requesterMemberId: po.createdById ?? actor,
        chargedDepartmentId,
        conflictMemberIds: [...new Set([...(po.createdById ? [po.createdById] : []), ...requests.map((r) => r.requesterMemberId)])],
        at: route.createdAt,
      },
    )
    if (!next.ok) return { ok: false, error: next.error }
    if (next.assigned) return { ok: true, result: { taskId: task.id, documentStatus: po.status }, events: [...events, ...next.events], notifications: next.notifications }
  }

  // The route ends: approved by the last step, returned or rejected
  const moved = transition(PO_MACHINE, po.status as PoState, COMMAND[final])
  if (!moved.ok) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `${COMMAND[final]} is not allowed from ${po.status}`, details: { from: po.status, command: COMMAND[final] } } }
  events.push(...(await closeRoute(tx, { type: 'PURCHASE_ORDER', id: po.id }, outcome === 'APPROVED' ? 'COMPLETED' : 'CANCELLED', 'DOCUMENT_DECIDED')))
  // The requests are locked before the budget lines (INV-PLT-03: the same order as submit)
  await lockRowsForUpdate(
    tx,
    'Request',
    ctx.organizationId,
    requests.map((r) => r.id),
  )
  const lines = await poBudgetLines(tx, po.id)
  if (outcome === 'APPROVED') {
    const budget = await commitForPo(tx, ctx, po.id, lines)
    // What is left and missing only for an approver who may view the budget lines (§2.4 budget.view)
    if (!budget.ok)
      return {
        ok: false,
        error: await budgetRefusalFor(
          tx,
          await loadPrincipal(tx, ctx),
          budget.error,
          lines.map((l) => l.budgetLineId),
        ),
      }
    const ordered = await orderSourceLines(tx, po.id)
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: moved.to, approvedAt: ctx.now, version: { increment: 1 } } })
    events.push({ type: 'po.approved', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { routeId: route.id, doaVersionId: route.doaVersionId, doaRuleCode: route.ruleCode, requests: ordered } }, ...budget.events)
    if (po.createdById) {
      notifications.push({
        recipientMemberId: po.createdById,
        templateKey: 'po.approved',
        data: { poId: po.id, number: po.number },
        urgency: 'IMMEDIATE',
        dedupeKey: `po.approved:${po.id}`,
        subjectType: 'PURCHASE_ORDER',
        subjectId: po.id,
      })
    }
  } else {
    const budget = await releasePoDelta(tx, ctx, po.id, lines)
    if (!budget.ok) return budget
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: moved.to, ...(outcome === 'RETURNED' ? { currentRouteId: null } : {}), version: { increment: 1 } } })
    events.push({ type: outcome === 'RETURNED' ? 'po.returned' : 'po.rejected', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { taskId: task.id, reasonCommentId: reasonCommentId! } }, ...budget.events)
  }
  return { ok: true, result: { taskId: task.id, documentStatus: moved.to }, events, notifications }
}
