import { TASK_MACHINE, transition, type TaskState } from '@/core/state-machines'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// A decision completes its step (spec §6.4 "ผู้รับร่วมอีกคนตัดสินแล้ว", BR-SLA-04 "whoever decides first decides",
// NEW-47). A step can hold more than one open task: the co-assignee the SLA job adds past escalateAt (ADR-048), or the
// task a delegation or an authority change moved there. The first decision — approve, return or reject, from any channel
// and by any of the four decide flows (requests, policy, purchase orders, receiving variances) — is the step's decision:
// in the same transaction every other task still OPEN or INFO_REQUESTED on the step is cancelled (version + 1) with
// approval_task.cancelled, why CO_ASSIGNEE_DECIDED. That event revokes the task's ActionTokens (applyTokenLifecycle,
// BR-TOK-01) and stops its SLA run (approval-task-sla and approval-task-resume are cancelled by it), so a later decision
// on it finds a closed task and is refused with who decided the step and when: on the web and in LIFF
// (INVALID_STATE_TRANSITION, decide.ts), from its LINE button and from its e-mail link (TOKEN_USED, line-postback.ts,
// action-link.ts).
//
// Locks (INV-PLT-03). Every path that acts on a task — decideCommand (the four decide flows), the LINE button, the
// e-mail link, a question and its answer — first locks the task together with every other open task of its step, in
// one ascending-id lock (lockForDecision), before the document, the token or anything else. Two approvers of one step
// who decide at the same moment both start with the step's lowest task id: the second waits there until the first
// commits, then finds its own task cancelled and is refused — no deadlock and no retry. completeStep reads the step's
// open tasks again under that lock. A task moved meanwhile — REASSIGNED by a delegation or an authority change that
// committed between the read and the lock — is left alone, and the task it moved to is found and locked by the next
// round. That task is the newest of the step, so its id is the largest (ids are uuid v7): its holder, deciding at that
// moment, waits first for the older open tasks of the step, which this transaction holds, so no cycle can form.

const OPEN_STATES = ['OPEN', 'INFO_REQUESTED'] as const

/**
 * The first lock of every path that acts on a task: the task and the other open tasks of its step, in one ascending-id
 * lock (INV-PLT-03). False when the task does not exist in this organization.
 */
export async function lockForDecision(tx: TenantTx, organizationId: string, taskId: string): Promise<boolean> {
  const task = await tx.approvalTask.findFirst({ where: { id: taskId }, select: { stepId: true } })
  if (!task) return false
  const open = await tx.approvalTask.findMany({ where: { stepId: task.stepId, status: { in: [...OPEN_STATES] } }, select: { id: true } })
  const locked = await lockRowsForUpdate(tx, 'ApprovalTask', organizationId, [taskId, ...open.map((t) => t.id)])
  return locked.includes(taskId)
}

/** What the helper needs of the task that was just decided (locked by the decide flow) */
export interface DecidedTask {
  readonly id: string
  readonly stepId: string
  readonly step: { readonly route: { readonly subjectId: string } }
}

/**
 * Called by every decide flow right after the decided task is written: cancels the step's other open tasks and marks
 * the step DONE. Returns the approval_task.cancelled events, to follow the decision's own event.
 */
export async function completeStep(tx: TenantTx, ctx: Ctx, decided: DecidedTask): Promise<EventDraft[]> {
  const events: EventDraft[] = []
  const handled = new Set<string>([decided.id])
  // Every round takes tasks not seen before, and only a move committed while this one waited makes a new one: it ends
  for (;;) {
    const others = await tx.approvalTask.findMany({ where: { stepId: decided.stepId, id: { notIn: [...handled] }, status: { in: [...OPEN_STATES] } }, select: { id: true } })
    if (others.length === 0) break
    // Held already when lockForDecision found them open; a task moved here after that lock is locked now
    const locked = await lockRowsForUpdate(
      tx,
      'ApprovalTask',
      ctx.organizationId,
      others.map((t) => t.id),
    )
    for (const id of others.map((t) => t.id)) handled.add(id)
    const still = await tx.approvalTask.findMany({ where: { id: { in: locked }, status: { in: [...OPEN_STATES] } }, select: { id: true, status: true }, orderBy: { id: 'asc' } })
    for (const task of still) {
      const moved = transition(TASK_MACHINE, task.status as TaskState, 'task.cancel')
      if (!moved.ok) continue
      await tx.approvalTask.update({ where: { id: task.id }, data: { status: moved.to, version: { increment: 1 } } })
      events.push({ type: 'approval_task.cancelled', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectId: decided.step.route.subjectId, why: 'CO_ASSIGNEE_DECIDED' } })
    }
  }
  await tx.approvalStep.update({ where: { id: decided.stepId }, data: { status: 'DONE' } })
  return events
}

/** Who decided a step and when; decidedBy is null when the decider's member row is gone */
export interface StepDecision {
  readonly decidedAt: Date
  readonly decidedBy: { readonly displayNameTh: string; readonly displayNameEn: string | null } | null
}

/**
 * The decision that closed a task (FR-DOA-004 AC2, §9.3 "ดำเนินการแล้วโดย … เมื่อ …"): its own, or — for a task
 * cancelled or moved with nothing decided of its own, because the other approver of an escalated step decided first
 * (BR-SLA-04) or a delegate decided the task it moved to — the first decision on its step. null: nothing was decided
 * (the task is still open, waits for an answer, or closed with the route: the request cancelled, the route replaced).
 */
export async function decisionOfStep(
  tx: TenantTx,
  task: { readonly stepId: string; readonly status: string; readonly decidedAt: Date | null; readonly decidedByMemberId: string | null },
): Promise<StepDecision | null> {
  const byStep = !task.decidedAt && (task.status === 'CANCELLED' || task.status === 'REASSIGNED')
  const decision = byStep
    ? await tx.approvalTask.findFirst({ where: { stepId: task.stepId, decidedAt: { not: null } }, orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }], select: { decidedAt: true, decidedByMemberId: true } })
    : task
  if (!decision?.decidedAt) return null
  const by = decision.decidedByMemberId ? await tx.member.findUnique({ where: { id: decision.decidedByMemberId }, select: { displayNameTh: true, displayNameEn: true } }) : null
  return { decidedAt: decision.decidedAt, decidedBy: by }
}
