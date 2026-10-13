import { z } from 'zod'
import { ok, type Result } from '@/core/result'
import { TASK_MACHINE, transition, type TaskState } from '@/core/state-machines'
import { stepOutcome, type SlotDecision } from '@/core/workflow'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { closingDecisionOf, type ClosingDecision, type DecidableTask } from '@/server/queries/tasks'

// A decision completes its slot, and with it maybe its step (spec §6.4 "ผู้รับร่วมอีกคนตัดสินแล้ว" and ApprovalStep
// with slots, BR-SLA-04 "whoever decides first decides", NEW-47, BR-WF-01). A step can hold more than one open task: the co-assignee the SLA job adds past escalateAt (ADR-048), or the
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

export type TaskDecision = 'APPROVE' | 'RETURN' | 'REJECT'

/**
 * What a step comes to after one of its tasks is decided (FR-DOA-004 AC6): OPEN while the step waits for more of its
 * tasks — the document does not move — otherwise the step's own result. Every decide flow moves its document by this,
 * never by the decision of the task, and finds the next step through assignNextStep only. A step of one approver comes
 * to the decision of its first task; a committee or a reviewer step (S6) to stepOutcome over its slots (BR-WF-01).
 */
export type StepOutcome = 'OPEN' | 'APPROVED' | 'RETURNED' | 'REJECTED'

export interface StepCompletion {
  readonly outcome: StepOutcome
  /** approval_task.cancelled of the tasks closed now, and approval_step.completed of a step of several slots */
  readonly events: readonly EventDraft[]
}

const OUTCOME_OF: Readonly<Record<TaskDecision, Exclude<StepOutcome, 'OPEN'>>> = { APPROVE: 'APPROVED', RETURN: 'RETURNED', REJECT: 'REJECTED' }

/** The decision a step's result stands for, for flows that name their document commands by decision */
export const FINAL_DECISION: Readonly<Record<Exclude<StepOutcome, 'OPEN'>, TaskDecision>> = { APPROVED: 'APPROVE', RETURNED: 'RETURN', REJECTED: 'REJECT' }

type CancelWhy = 'CO_ASSIGNEE_DECIDED' | 'GROUP_DECIDED' | 'STEP_DECIDED'

/**
 * Cancels the step's open tasks that `which` picks, each with approval_task.cancelled. Every round takes tasks not seen
 * before, and only a move committed while this one waited makes a new one: it ends.
 */
async function cancelOpenTasks(tx: TenantTx, ctx: Ctx, decided: DecidedTask, which: (slotNo: number) => boolean, why: CancelWhy, handled: Set<string>, events: EventDraft[]) {
  for (;;) {
    const others = (await tx.approvalTask.findMany({ where: { stepId: decided.stepId, id: { notIn: [...handled] }, status: { in: [...OPEN_STATES] } }, select: { id: true, slotNo: true } })).filter((t) =>
      which(t.slotNo),
    )
    if (others.length === 0) return
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
      events.push({ type: 'approval_task.cancelled', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectId: decided.step.route.subjectId, why } })
    }
  }
}

const ReviewGroupsJson = z.array(z.object({ quorum: z.enum(['ALL', 'ANY', 'COUNT']), quorumCount: z.number().int().positive().nullable().optional(), slotNos: z.array(z.number().int().positive()).min(1) }))

/**
 * Called by every decide flow right after the decided task is written: closes the other open tasks of the decided
 * slot (a co-assignee, a moved task: whoever decides first decides the slot), counts the slots of a committee or a
 * reviewer step (stepOutcome · BR-WF-01), closes the slots a decided group or step no longer needs, marks the step DONE
 * once it has its result and says what it came to. A failure — a reviewer cannot reject (REVIEW_CANNOT_REJECT) — rolls
 * the whole command back (the pipeline throws on it), so the task stays open.
 */
export async function completeStep(tx: TenantTx, ctx: Ctx, decided: DecidedTask, decision: TaskDecision): Promise<Result<StepCompletion>> {
  const events: EventDraft[] = []
  const handled = new Set<string>([decided.id])
  const step = await tx.approvalStep.findUniqueOrThrow({
    where: { id: decided.stepId },
    select: { stepNo: true, routeId: true, kind: true, mode: true, quorum: true, quorumCount: true, reviewGroups: true, route: { select: { subjectType: true } } },
  })
  const { slotNo } = await tx.approvalTask.findUniqueOrThrow({ where: { id: decided.id }, select: { slotNo: true } })
  // The slot is decided: its other open tasks close as the co-assignee's did before S6 (BR-SLA-04)
  await cancelOpenTasks(tx, ctx, decided, (n) => n === slotNo, 'CO_ASSIGNEE_DECIDED', handled, events)

  const slotted = step.mode === 'PARALLEL' || step.kind === 'REVIEW'
  if (!slotted) {
    await tx.approvalStep.update({ where: { id: decided.stepId }, data: { status: 'DONE' } })
    return ok({ outcome: OUTCOME_OF[decision], events })
  }

  // What each slot came to: the first decision of the slot (§6.4 "การตัดสินแรกของ slot คือผลของ slot")
  const tasks = await tx.approvalTask.findMany({ where: { stepId: decided.stepId }, select: { slotNo: true, decision: true, decidedAt: true }, orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }] })
  const slotCount = Math.max(...tasks.map((t) => t.slotNo))
  const slots: (SlotDecision | null)[] = Array.from({ length: slotCount }, () => null)
  for (const t of tasks) if (t.decision && t.decidedAt && slots[t.slotNo - 1] === null) slots[t.slotNo - 1] = t.decision
  const groups = step.kind === 'REVIEW' ? ReviewGroupsJson.parse(step.reviewGroups).map((g) => ({ quorum: g.quorum, quorumCount: g.quorumCount ?? null, slots: g.slotNos })) : undefined
  const result = stepOutcome({ kind: step.kind, quorum: step.quorum, quorumCount: step.quorumCount, ...(groups ? { groups } : {}), slots })
  if (!result.ok) return result
  const { outcome, cancel } = result.data
  const closing = new Set(cancel)
  await cancelOpenTasks(tx, ctx, decided, (n) => closing.has(n), outcome === 'OPEN' ? 'GROUP_DECIDED' : 'STEP_DECIDED', handled, events)
  if (outcome === 'OPEN') return ok({ outcome, events })

  await tx.approvalStep.update({ where: { id: decided.stepId }, data: { status: 'DONE' } })
  events.push({
    type: 'approval_step.completed',
    aggregateType: 'ApprovalStep',
    aggregateId: decided.stepId,
    data: {
      subjectType: step.route.subjectType,
      subjectId: decided.step.route.subjectId,
      routeId: step.routeId,
      stepNo: step.stepNo,
      kind: step.kind,
      outcome,
      quorum: step.quorum,
      quorumCount: step.quorumCount,
      slots,
    },
  })
  return ok({ outcome, events })
}

/** What approval_task.decided says (FR-DOA-005 AC1, INV-DOA-01) */
export interface DecidedEventInput {
  /** slotNo and the step's mode and kind (as the decide flows load the task) add the slot of a step of several slots */
  readonly task: { readonly id: string; readonly principalMemberId: string | null; readonly slotNo?: number; readonly step?: unknown }
  readonly route: { readonly doaVersionId: string; readonly ruleCode: string }
  readonly subjectType: string
  readonly subjectId: string
  readonly decision: TaskDecision
  readonly actorMemberId: string
  readonly reasonCommentId: string | null
  readonly stepUpGrantId?: string | null
  /** What a flow adds of its own, e.g. the policy flow's boundaryTableConfirmed */
  readonly extra?: Readonly<Record<string, unknown>>
}

/** The step of a task is a committee's or the reviewers' (several slots): as the decide flows load it, with its columns */
function slottedStep(step: unknown): boolean {
  const s = step as { readonly mode?: unknown; readonly kind?: unknown } | null | undefined
  return s?.mode === 'PARALLEL' || s?.kind === 'REVIEW'
}

/**
 * The approval_task.decided event of every decide flow, built in one place: the DOA version and rule of the route, the
 * channel, the actor and whom they act for. S6 adds the parallel reviewer's fields here.
 */
export function decidedEvent(ctx: Ctx, e: DecidedEventInput): EventDraft {
  const onBehalf = e.task.principalMemberId && e.actorMemberId !== e.task.principalMemberId ? e.task.principalMemberId : null
  return {
    type: 'approval_task.decided',
    aggregateType: 'ApprovalTask',
    aggregateId: e.task.id,
    doaVersionId: e.route.doaVersionId,
    doaRuleCode: e.route.ruleCode,
    ...(onBehalf ? { onBehalfOfMemberId: onBehalf } : {}),
    data: {
      decision: e.decision,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
      doaVersionId: e.route.doaVersionId,
      doaRuleCode: e.route.ruleCode,
      channel: ctx.channel,
      actorMemberId: e.actorMemberId,
      onBehalfOfMemberId: onBehalf,
      reasonCommentId: e.reasonCommentId,
      ...(e.stepUpGrantId ? { stepUpGrantId: e.stepUpGrantId } : {}),
      ...(e.task.slotNo !== undefined && slottedStep(e.task.step) ? { slotNo: e.task.slotNo } : {}),
      ...e.extra,
    },
  }
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
