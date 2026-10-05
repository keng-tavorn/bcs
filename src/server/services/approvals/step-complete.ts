import { TASK_MACHINE, transition, type TaskState } from '@/core/state-machines'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { closingDecisionOf, type ClosingDecision, type DecidableTask } from '@/server/queries/tasks'

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
export type StepDecision = ClosingDecision

/**
 * The decision that closed a task (FR-DOA-004 AC2, §9.3 "ดำเนินการแล้วโดย … เมื่อ …"): its own, or — for a task
 * cancelled or moved with nothing decided of its own, because the other approver of an escalated step decided first
 * (BR-SLA-04) or a delegate decided the task it moved to — the first decision on its step. null: nothing was decided
 * (the task is still open, waits for an answer, or closed with the route: the request cancelled, the route replaced).
 * One rule for every answer, with the decision page's (closingDecisionOf, src/server/queries/tasks.ts). Called inside
 * the command, after the task is locked (lockForDecision) and after the actor was checked: a refusal names the
 * decider only to whoever may act on the task — a member without it is refused FORBIDDEN first (decide.ts), and a
 * button or link of someone else's FORBIDDEN or TOKEN_INVALID (line-postback.ts, action-link.ts).
 */
export function decisionOfStep(tx: TenantTx, task: DecidableTask): Promise<StepDecision | null> {
  return closingDecisionOf(tx, task)
}

/**
 * Why a decision button or link (ActionToken) cannot be used now, read again after its one conditional update took no
 * row (BR-TOK-04): TOKEN_USED with who decided and when (§9.3) whenever its task was decided — with this token or
 * anywhere else: on the web, in LIFF, from the chat, by e-mail — or closed by the decision of another task of its step
 * (the other approver of an escalated step, the delegate it moved to); TOKEN_INVALID when it was revoked with nothing
 * decided (the task moved or was cancelled with its route); TOKEN_EXPIRED otherwise (ADR-050 item 4). The same answer
 * for the LINE button and the e-mail link; both check that the token is the actor's before they ask.
 */
export async function tokenRefusalOf(
  tx: TenantTx,
  tokenId: string,
): Promise<{ readonly code: 'TOKEN_USED'; readonly decision: StepDecision | null } | { readonly code: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' }> {
  const token = await tx.actionToken.findUniqueOrThrow({ where: { id: tokenId }, select: { taskId: true, usedAt: true, revokedAt: true } })
  const task = await tx.approvalTask.findUniqueOrThrow({ where: { id: token.taskId }, select: { id: true, stepId: true, status: true, decision: true, decidedAt: true, decidedByMemberId: true } })
  const decision = await decisionOfStep(tx, task)
  // A token used with a decision always finds it; usedAt alone still means the button's work is done
  if (decision || token.usedAt) return { code: 'TOKEN_USED', decision }
  return { code: token.revokedAt ? 'TOKEN_INVALID' : 'TOKEN_EXPIRED' }
}

/** The details of TOKEN_USED, as §14.2 words it ("ดำเนินการแล้วโดย {name} เมื่อ {time}"): the name in Thai and in English */
export function deciderDetails(decision: StepDecision | null): Record<string, string> {
  const by = decision?.decidedBy
  return {
    ...(by ? { name: by.displayNameTh, nameEn: by.displayNameEn ?? by.displayNameTh } : {}),
    ...(decision ? { time: decision.decidedAt.toISOString() } : {}),
  }
}
