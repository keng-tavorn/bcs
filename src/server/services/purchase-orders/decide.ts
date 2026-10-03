import { checkSod, type SodPolicy } from '@/core/sod'
import { PO_MACHINE, transition, type PoState, type TaskState } from '@/core/state-machines'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import type { CommandOutcome } from '../_pipeline'
import { assignNextStep } from '../approvals/next-step'
import { closeRoute } from '../approvals/route'
import { commitForPo, poBudgetLines, releasePoDelta } from './budget'
import { orderSourceLines } from './requests'

// Deciding a PO's approval task (spec §6.4 PO table, FR-P2P-004, BR-BUD-05, BR-SOD-01, BR-SOD-03): the assignee — or
// the delegator of a delegate — decides; at that moment neither the requesters of the PO's requests nor its creator
// may (checked again here, not only when the route was made). The last approval holds the budget and orders the
// request lines; a rejection or a return gives back the delta reserved at submit (a return leaves a draft to edit).

export interface DocumentTask {
  readonly id: string
  readonly stepId: string
  readonly principalMemberId: string | null
  readonly step: { readonly route: { readonly id: string; readonly subjectId: string; readonly doaVersionId: string; readonly ruleCode: string; readonly createdAt: Date } }
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
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { sodPolicy: true } })
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

  let reasonCommentId: string | null = null
  if (input.decision !== 'APPROVE') {
    reasonCommentId = newId()
    await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: 'PurchaseOrder', subjectId: po.id, authorMemberId: actor, body: input.reason! } })
  }
  await tx.approvalTask.update({
    where: { id: task.id },
    data: { status: taskTo, decision: input.decision, decidedAt: ctx.now, decidedByMemberId: actor, channel: ctx.channel, reason: input.reason ?? null, version: { increment: 1 } },
  })
  await tx.approvalStep.update({ where: { id: task.stepId }, data: { status: 'DONE' } })
  const events: EventDraft[] = [
    {
      type: 'approval_task.decided',
      aggregateType: 'ApprovalTask',
      aggregateId: task.id,
      doaVersionId: route.doaVersionId,
      doaRuleCode: route.ruleCode,
      ...(task.principalMemberId && actor !== task.principalMemberId ? { onBehalfOfMemberId: task.principalMemberId } : {}),
      data: {
        decision: input.decision,
        subjectType: 'PURCHASE_ORDER',
        subjectId: po.id,
        doaVersionId: route.doaVersionId,
        doaRuleCode: route.ruleCode,
        channel: ctx.channel,
        actorMemberId: actor,
        onBehalfOfMemberId: task.principalMemberId && actor !== task.principalMemberId ? task.principalMemberId : null,
        reasonCommentId,
      },
    },
  ]
  const notifications: NotificationDraft[] = []

  if (input.decision === 'APPROVE') {
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
  const moved = transition(PO_MACHINE, po.status as PoState, COMMAND[input.decision])
  if (!moved.ok) return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: `${COMMAND[input.decision]} is not allowed from ${po.status}`, details: { from: po.status, command: COMMAND[input.decision] } } }
  events.push(...(await closeRoute(tx, { type: 'PURCHASE_ORDER', id: po.id }, input.decision === 'APPROVE' ? 'COMPLETED' : 'CANCELLED', 'DOCUMENT_DECIDED')))
  // The requests are locked before the budget lines (INV-PLT-03: the same order as submit)
  await lockRowsForUpdate(
    tx,
    'Request',
    ctx.organizationId,
    requests.map((r) => r.id),
  )
  const lines = await poBudgetLines(tx, po.id)
  if (input.decision === 'APPROVE') {
    const budget = await commitForPo(tx, ctx, po.id, lines)
    if (!budget.ok) return budget
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
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: moved.to, ...(input.decision === 'RETURN' ? { currentRouteId: null } : {}), version: { increment: 1 } } })
    events.push({ type: input.decision === 'RETURN' ? 'po.returned' : 'po.rejected', aggregateType: 'PurchaseOrder', aggregateId: po.id, data: { taskId: task.id, reasonCommentId: reasonCommentId! } }, ...budget.events)
  }
  return { ok: true, result: { taskId: task.id, documentStatus: moved.to }, events, notifications }
}
