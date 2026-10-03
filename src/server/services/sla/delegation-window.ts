import { z } from 'zod'
import { delegateFor } from '@/core/delegation'
import type { DelegationSnapshot, DelegationStatus, DoaDocumentType } from '@/core/doa'
import type { AppError } from '@/core/result'
import { TASK_MACHINE, transition, type TaskState } from '@/core/state-machines'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { loadDelegations, loadOrgSnapshot } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import type { ApprovalSubject } from '../approvals/route'
import { markDelegationWindow } from '../delegations'
import { refusalOf, type StepRefusal } from './step-result'
import { subjectData, subjectFacts } from './subject'

// The period of a delegation (spec §4.6 delegation-window, §6.4 ApprovalTask "delegation เริ่มหรือจบ" and Delegation,
// BR-DLG-04, FR-DOA-006 AC3): when it starts, the open tasks the delegator holds from a position move to the delegate,
// who acts on their behalf (principal = delegator); when it ends — or is revoked (NEW-35) — the tasks the delegate still
// holds for the delegator move back. Each move is REASSIGNED → a new task with the same step, DOA reference and times,
// and one approval_task.reassigned event, so the old task's ActionTokens are revoked and the new holder gets theirs
// (BR-TOK-01). Both sides are told. The rules of routing apply to every move (core delegateFor): a delegation covers
// only its document types and cap (BR-DLG-01), a task the delegator holds as someone's delegate is never passed on
// (BR-DLG-02), and a delegate who conflicts with the document leaves the task with the delegator while ORG_ADMIN is
// told (BR-DLG-05). Work never moves to a member who is not ACTIVE: a delegator deactivated meanwhile (BR-AUTH-06 revokes
// their delegations) does not get the tasks back — they stay with the active delegate, and the deactivation already
// told ORG_ADMIN to reassign them (it counts the tasks held on the member's behalf). The stored status follows the
// period through the delegation service (SCHEDULED → ACTIVE → ENDED, markDelegationWindow).

export const WINDOW_JOB = 'delegation-window'
const OPEN_STATES = ['OPEN', 'INFO_REQUESTED'] as const

const refuse = (code: 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED', reason: string, message = reason, extra: Record<string, unknown> = {}): CommandOutcome<never> => ({
  ok: false,
  error: { code, message, details: { reason, ...extra } },
})
const systemOnly = (): CommandOutcome<never> => ({ ok: false, error: { code: 'FORBIDDEN', message: 'only the delegation-window job runs this', details: { reason: 'SYSTEM_ONLY' } } })

const WindowInput = z.strictObject({ delegationId: z.uuid() })

async function lockedDelegation(tx: TenantTx, ctx: Ctx, delegationId: string) {
  const [locked] = await lockRowsForUpdate(tx, 'Delegation', ctx.organizationId, [delegationId])
  return locked ? tx.delegation.findUniqueOrThrow({ where: { id: delegationId } }) : null
}
type DelegationRow = NonNullable<Awaited<ReturnType<typeof lockedDelegation>>>

function snapshotOf(d: DelegationRow, status: DelegationStatus): DelegationSnapshot {
  return {
    id: d.id,
    delegatorMemberId: d.delegatorMemberId,
    delegateMemberId: d.delegateMemberId,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    documentTypes: d.documentTypes.length ? (d.documentTypes as DoaDocumentType[]) : null,
    maxAmountSatang: d.maxAmountSatang,
    status,
  }
}

const recorded = async (tx: TenantTx, type: 'delegation.started' | 'delegation.ended', delegationId: string) => (await tx.event.count({ where: { type, aggregateId: delegationId } })) > 0

async function orgAdmins(tx: TenantTx): Promise<string[]> {
  const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  return [...new Set(admins.map((a) => a.memberId))].sort()
}

/** Open tasks matching `where`, locked in id order (INV-PLT-03) and read again under the lock */
async function lockedOpenTasks(tx: TenantTx, ctx: Ctx, where: { assigneeMemberId: string; principalMemberId: string | null; resolvedFrom?: { startsWith: string } }) {
  const candidates = await tx.approvalTask.findMany({ where: { ...where, status: { in: [...OPEN_STATES] } }, select: { id: true } })
  const locked = await lockRowsForUpdate(
    tx,
    'ApprovalTask',
    ctx.organizationId,
    candidates.map((c) => c.id),
  )
  return tx.approvalTask.findMany({ where: { id: { in: locked }, ...where, status: { in: [...OPEN_STATES] } }, include: { step: { include: { route: true } } }, orderBy: { id: 'asc' } })
}
type OpenTask = Awaited<ReturnType<typeof lockedOpenTasks>>[number]

interface Moves {
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
  /** Tasks left where they are because routing would send them to a member who is not ACTIVE */
  readonly kept: number
}

/** One move of §6.4: the task becomes REASSIGNED and a new one goes to the new holder with everything else the same */
async function moveTask(tx: TenantTx, ctx: Ctx, task: OpenTask, to: { readonly assigneeMemberId: string; readonly principalMemberId: string | null }): Promise<EventDraft | null> {
  const t = transition(TASK_MACHINE, task.status as TaskState, 'task.reassign')
  if (!t.ok) return null
  await tx.approvalTask.update({ where: { id: task.id }, data: { status: t.to, version: { increment: 1 } } })
  const moved = await tx.approvalTask.create({
    data: {
      organizationId: ctx.organizationId,
      stepId: task.stepId,
      assigneeMemberId: to.assigneeMemberId,
      principalMemberId: to.principalMemberId,
      resolvedFrom: task.resolvedFrom,
      status: task.status,
      assignedAt: ctx.now,
      dueAt: task.dueAt,
      remindAt: task.remindAt,
      escalateAt: task.escalateAt,
      remainingBusinessMinutes: task.remainingBusinessMinutes,
      overdueAt: task.overdueAt,
      escalatedAt: task.escalatedAt,
      reassignedFromTaskId: task.id,
    },
    select: { id: true },
  })
  // A question still waiting for its answer follows the task, as when a position holder changes (NEW-28)
  if (task.status === 'INFO_REQUESTED') await tx.infoRequest.updateMany({ where: { taskId: task.id, answeredAt: null }, data: { taskId: moved.id } })
  return {
    type: 'approval_task.reassigned',
    aggregateType: 'ApprovalTask',
    aggregateId: moved.id,
    data: { fromTaskId: task.id, fromMemberId: task.assigneeMemberId, toMemberId: to.assigneeMemberId, why: 'DELEGATION', changeId: null },
  }
}

/** BR-DLG-05: ORG_ADMIN hears that a task stays with the delegator because the delegate is tied to the document */
async function conflictNotices(tx: TenantTx, task: OpenTask, subject: Awaited<ReturnType<typeof subjectFacts>>): Promise<NotificationDraft[]> {
  return (await orgAdmins(tx)).map((admin) => ({
    recipientMemberId: admin,
    templateKey: 'approval_task.delegate_conflict',
    data: { ...subjectData(subject), taskId: task.id },
    urgency: 'IMMEDIATE' as const,
    dedupeKey: `approval_task.delegate_conflict:${task.id}:${admin}`,
    subjectType: subject.type,
    subjectId: subject.id,
  }))
}

const contextOf = (task: OpenTask, subject: Awaited<ReturnType<typeof subjectFacts>>, at: Date) => ({
  documentType: subject.documentType,
  basisAmountSatang: task.step.route.amountSatang,
  at,
  conflictMemberIds: subject.conflictMemberIds,
})

/** The start: open tasks of the delegator's positions move to the delegate where the delegation covers them */
async function moveToDelegate(tx: TenantTx, ctx: Ctx, d: DelegationRow): Promise<Moves> {
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  const delegate = await tx.member.findUnique({ where: { id: d.delegateMemberId }, select: { status: true } })
  // BR-DLG-03: a delegate who is not ACTIVE holds nothing
  if (delegate?.status !== 'ACTIVE') return { events, notifications, kept: 0 }
  // BR-DLG-02: only tasks the delegator holds in their own right (principal null), and authority from a position
  const tasks = await lockedOpenTasks(tx, ctx, { assigneeMemberId: d.delegatorMemberId, principalMemberId: null, resolvedFrom: { startsWith: 'POSITION:' } })
  const window = [snapshotOf(d, 'ACTIVE')]
  for (const task of tasks) {
    // The delegate already decides this step (for example as its co-assignee): there is nothing to hand over
    if (await tx.approvalTask.count({ where: { stepId: task.stepId, status: { in: [...OPEN_STATES] }, OR: [{ assigneeMemberId: d.delegateMemberId }, { principalMemberId: d.delegateMemberId }] } })) continue
    const subject = await subjectFacts(tx, task.step.route.subjectType as ApprovalSubject, task.step.route.subjectId)
    const holder = delegateFor({ memberId: d.delegatorMemberId, viaPosition: true }, contextOf(task, subject, ctx.now), window)
    if (holder.notifyOrgAdmin) notifications.push(...(await conflictNotices(tx, task, subject)))
    if (holder.assigneeMemberId === d.delegatorMemberId) continue
    const event = await moveTask(tx, ctx, task, holder)
    if (event) events.push(event)
  }
  return { events, notifications, kept: 0 }
}

/**
 * The end (or a revocation): what the delegate still holds for the delegator goes where routing would send it now —
 * back to the delegator, or to the delegate of another delegation of theirs that runs now and covers it (a period that
 * starts exactly when this one ends keeps its tasks with its own delegate, whichever job runs first). A target who is
 * not ACTIVE gets nothing: the task stays with the delegate (counted in `kept`).
 */
async function moveBack(tx: TenantTx, ctx: Ctx, d: DelegationRow): Promise<Moves> {
  const events: EventDraft[] = []
  const notifications: NotificationDraft[] = []
  const tasks = await lockedOpenTasks(tx, ctx, { assigneeMemberId: d.delegateMemberId, principalMemberId: d.delegatorMemberId })
  if (tasks.length === 0) return { events, notifications, kept: 0 }
  const others = (await loadDelegations(tx)).filter((o) => o.id !== d.id && o.delegatorMemberId === d.delegatorMemberId)
  const org = await loadOrgSnapshot(tx)
  const active = (memberId: string) => org.members.find((m) => m.id === memberId)?.active === true
  let kept = 0
  for (const task of tasks) {
    const subject = await subjectFacts(tx, task.step.route.subjectType as ApprovalSubject, task.step.route.subjectId)
    const target = delegateFor({ memberId: d.delegatorMemberId, viaPosition: true }, contextOf(task, subject, ctx.now), others, active)
    if (target.assigneeMemberId === d.delegateMemberId && target.principalMemberId === d.delegatorMemberId) continue
    // BR-AUTH-06: no work and no ActionToken for a member who is not ACTIVE
    if (!active(target.assigneeMemberId)) {
      kept++
      continue
    }
    if (target.notifyOrgAdmin) notifications.push(...(await conflictNotices(tx, task, subject)))
    const event = await moveTask(tx, ctx, task, target)
    if (event) events.push(event)
  }
  return { events, notifications, kept }
}

type Phase = 'STARTED' | 'ENDED' | 'REVOKED'

/** Both sides are told (FR-DOA-006 AC3); a side who is no longer ACTIVE is not. `kept`: tasks the delegate still holds */
async function windowNotices(tx: TenantTx, d: DelegationRow, phase: Phase, movedTasks: number, who: ReadonlyArray<'DELEGATOR' | 'DELEGATE'>, kept = 0): Promise<NotificationDraft[]> {
  const members = await tx.member.findMany({ where: { id: { in: [d.delegatorMemberId, d.delegateMemberId] }, status: 'ACTIVE' }, select: { id: true } })
  const reachable = new Set(members.map((m) => m.id))
  return who.flatMap((role) => {
    const memberId = role === 'DELEGATOR' ? d.delegatorMemberId : d.delegateMemberId
    if (!reachable.has(memberId)) return []
    return [
      {
        recipientMemberId: memberId,
        templateKey: 'delegation.window',
        data: { delegationId: d.id, phase, role, movedTasks, ...(kept > 0 ? { keptTasks: kept } : {}), startsAt: d.startsAt.toISOString(), endsAt: d.endsAt.toISOString() },
        urgency: 'IMMEDIATE' as const,
        dedupeKey: `delegation.window:${d.id}:${phase}:${memberId}`,
        subjectType: 'DELEGATION',
        subjectId: d.id,
      },
    ]
  })
}

/**
 * BR-AUTH-06 (§10.1 admin.reassign_needed): the delegate still holds tasks of a delegator who is no longer ACTIVE, so
 * ORG_ADMIN reassigns them. Used at the end of a period; a revocation that comes with a deactivation needs none, because
 * the deactivation told ORG_ADMIN already (it counts the tasks held on the member's behalf).
 */
async function reassignNotices(tx: TenantTx, d: DelegationRow, openTasks: number): Promise<NotificationDraft[]> {
  const delegator = await tx.member.findUniqueOrThrow({ where: { id: d.delegatorMemberId }, select: { displayNameTh: true } })
  return (await orgAdmins(tx)).map((admin) => ({
    recipientMemberId: admin,
    templateKey: 'admin.reassign_needed',
    data: { memberId: d.delegatorMemberId, name: delegator.displayNameTh, openTasks },
    urgency: 'IMMEDIATE' as const,
    dedupeKey: `admin.reassign_needed:delegation:${d.id}:${admin}`,
    subjectType: 'MEMBER',
    subjectId: d.delegatorMemberId,
  }))
}

type WindowResult = { delegationId: string; movedTasks: number; status: string }

export const startDelegationWindowCommand = defineCommand({
  name: 'delegation.start_window',
  capability: 'delegation.manage',
  input: WindowInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<WindowResult>> {
    if (ctx.actor.type !== 'SYSTEM') return systemOnly()
    const d = await lockedDelegation(tx, ctx, input.delegationId)
    if (!d) return refuse('NOT_FOUND', 'NOT_FOUND', 'delegation not found')
    if (d.status === 'REVOKED' || d.status === 'ENDED' || d.revokedAt) return refuse('INVALID_STATE_TRANSITION', d.status, 'the delegation no longer runs')
    if (ctx.now.getTime() < d.startsAt.getTime()) return refuse('VALIDATION_FAILED', 'NOT_DUE', 'the period has not started', { at: d.startsAt.toISOString() })
    if (await recorded(tx, 'delegation.started', d.id)) return refuse('INVALID_STATE_TRANSITION', 'ALREADY_STARTED', 'the start was handled already')
    // A start handled after the period ended moves nothing: the end gives back whatever the delegate holds
    const moves = ctx.now.getTime() < d.endsAt.getTime() ? await moveToDelegate(tx, ctx, d) : { events: [], notifications: [], kept: 0 }
    const movedTasks = moves.events.length
    // §6.4 SCHEDULED → ACTIVE (a delegation set while its period runs is ACTIVE from the start)
    const status = (await markDelegationWindow(tx, d.id, 'delegation.start')) ?? d.status
    return {
      ok: true,
      result: { delegationId: d.id, movedTasks, status },
      events: [...moves.events, { type: 'delegation.started', aggregateType: 'Delegation', aggregateId: d.id, data: { movedTasks } }],
      notifications: [...(await windowNotices(tx, d, 'STARTED', movedTasks, ['DELEGATOR', 'DELEGATE'])), ...moves.notifications],
    }
  },
})

export const endDelegationWindowCommand = defineCommand({
  name: 'delegation.end_window',
  capability: 'delegation.manage',
  input: WindowInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<WindowResult>> {
    if (ctx.actor.type !== 'SYSTEM') return systemOnly()
    const d = await lockedDelegation(tx, ctx, input.delegationId)
    if (!d) return refuse('NOT_FOUND', 'NOT_FOUND', 'delegation not found')
    // A revoked delegation gave its tasks back when it was revoked (returnRevokedDelegationTasks)
    if (d.status === 'REVOKED' || d.revokedAt) return refuse('INVALID_STATE_TRANSITION', 'REVOKED', 'the delegation was revoked')
    if (ctx.now.getTime() < d.endsAt.getTime()) return refuse('VALIDATION_FAILED', 'NOT_DUE', 'the period has not ended', { at: d.endsAt.toISOString() })
    if (await recorded(tx, 'delegation.ended', d.id)) return refuse('INVALID_STATE_TRANSITION', 'ALREADY_ENDED', 'the end was handled already')
    const moves = await moveBack(tx, ctx, d)
    const movedTasks = moves.events.length
    // §6.4 → ENDED, through ACTIVE when the start was never handled
    if (d.status === 'SCHEDULED') await markDelegationWindow(tx, d.id, 'delegation.start')
    const status = (await markDelegationWindow(tx, d.id, 'delegation.end')) ?? d.status
    return {
      ok: true,
      result: { delegationId: d.id, movedTasks, status },
      events: [...moves.events, { type: 'delegation.ended', aggregateType: 'Delegation', aggregateId: d.id, data: { movedTasks } }],
      notifications: [
        ...(await windowNotices(tx, d, 'ENDED', movedTasks, ['DELEGATOR', 'DELEGATE'], moves.kept)),
        ...moves.notifications,
        ...(moves.kept > 0 ? await reassignNotices(tx, d, moves.kept) : []),
      ],
    }
  },
})

export const returnRevokedTasksCommand = defineCommand({
  name: 'delegation.return_revoked',
  capability: 'delegation.manage',
  input: WindowInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<WindowResult>> {
    if (ctx.actor.type !== 'SYSTEM') return systemOnly()
    const d = await lockedDelegation(tx, ctx, input.delegationId)
    if (!d) return refuse('NOT_FOUND', 'NOT_FOUND', 'delegation not found')
    if (d.status !== 'REVOKED') return refuse('INVALID_STATE_TRANSITION', d.status, 'the delegation is not revoked')
    const moves = await moveBack(tx, ctx, d)
    if (moves.events.length === 0) {
      // A delegator deactivated meanwhile gets nothing back; their deactivation told ORG_ADMIN to reassign these tasks
      return moves.kept > 0
        ? refuse('INVALID_STATE_TRANSITION', 'DELEGATOR_INACTIVE', 'the delegator is not active: the tasks stay with the delegate for ORG_ADMIN to reassign', { kept: moves.kept })
        : refuse('NOT_FOUND', 'NOTHING_TO_MOVE', 'the delegate holds no task of the delegator')
    }
    // The delegate heard of the revocation from the revoke command (delegation.revoked); the delegator gets the tasks back
    return {
      ok: true,
      result: { delegationId: d.id, movedTasks: moves.events.length, status: d.status },
      events: moves.events,
      notifications: [...(await windowNotices(tx, d, 'REVOKED', moves.events.length, ['DELEGATOR'])), ...moves.notifications],
    }
  },
})

export type WindowStepResult = { readonly done: true; readonly movedTasks: number } | StepRefusal

const windowResult = (r: { ok: true; data: { movedTasks: number } } | { ok: false; error: AppError }, now: Date): WindowStepResult =>
  r.ok ? { done: true, movedTasks: r.data.movedTasks } : refusalOf(r.error, now)

/** Handler at startsAt (FR-DOA-006 AC3) */
export async function startDelegationWindow(organizationId: string, delegationId: string, now: Date): Promise<WindowStepResult> {
  return windowResult(await runCommand(systemCtx(organizationId, now, WINDOW_JOB), startDelegationWindowCommand, { delegationId }, { idempotencyKey: `${WINDOW_JOB}:start:${delegationId}` }), now)
}

/** Handler at endsAt (FR-DOA-006 AC3) */
export async function endDelegationWindow(organizationId: string, delegationId: string, now: Date): Promise<WindowStepResult> {
  return windowResult(await runCommand(systemCtx(organizationId, now, WINDOW_JOB), endDelegationWindowCommand, { delegationId }, { idempotencyKey: `${WINDOW_JOB}:end:${delegationId}` }), now)
}

/** Handler of delegation.revoked: a revoked delegation ends at once, so its tasks go back now (BR-DLG-04, NEW-35) */
export async function returnRevokedDelegationTasks(organizationId: string, delegationId: string, now: Date): Promise<WindowStepResult> {
  return windowResult(await runCommand(systemCtx(organizationId, now, WINDOW_JOB), returnRevokedTasksCommand, { delegationId }, { idempotencyKey: `${WINDOW_JOB}:revoked:${delegationId}` }), now)
}
