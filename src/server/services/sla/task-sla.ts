import { z } from 'zod'
import { systemCtx, type Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadDelegations, loadOrgSnapshot } from '@/server/doa/policy'
import { versionSnapshotFromRows } from '@/server/doa/snapshot'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome } from '../_pipeline'
import type { ApprovalSubject } from '../approvals/route'
import { nextBandApprover, type NextBand } from './next-band'
import { slaPolicyOf, slaTimes, type SlaTimes } from './policy'
import { refusalOf, type StepRefusal } from './step-result'
import { subjectData, subjectFacts, type SubjectFacts } from './subject'

// The SLA of an approval task (spec §4.6 approval-task-sla, §7.8 BR-SLA-02 to BR-SLA-04, FR-NOTI-003): the job sleeps
// until each time and calls one of these handlers with the time it woke. Every handler reads the task again first and
// leaves a task that is decided, cancelled, moved or waiting for the requester alone (FR-NOTI-003 AC3, §4.6 rule 1);
// each runs one system command whose idempotency key names the task (and the due time), so a retry repeats nothing
// (§4.6 rule 2). A time is checked against the latest state: when the calendar moved it after the job planned (a
// holiday imported meanwhile) or the job woke early, the refusal NOT_DUE says when it is due and the job waits again.
// A busy database is no answer: the handler throws and Inngest retries the step (step-result.ts). Approval and SLA
// notices cannot be turned off (BR-NOTI-04): they ignore the member's preferences.

export const SLA_JOB = 'approval-task-sla'

/** What the timer job needs, JSON-safe for Inngest step results */
export interface TaskSlaPlan {
  readonly taskId: string
  readonly status: string
  /** OPEN: the timers run; anything else (waiting for the requester, decided, cancelled, moved) ends them */
  readonly open: boolean
  readonly remindAt: string | null
  readonly dueAt: string | null
  readonly escalateAt: string | null
}

export type SlaStepResult = { readonly done: true } | StepRefusal

const OPEN_STATES = ['OPEN', 'INFO_REQUESTED'] as const

const refuse = (code: 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED' | 'FORBIDDEN', reason: string, message = reason, extra: Record<string, unknown> = {}): CommandOutcome<never> => ({
  ok: false,
  error: { code, message, details: { reason, ...extra } },
})
const systemOnly = (): CommandOutcome<never> => ({ ok: false, error: { code: 'FORBIDDEN', message: 'only the SLA job runs this', details: { reason: 'SYSTEM_ONLY' } } })
/** Not yet: `at` is when it is due by the stored task and today's calendar (step-result.ts) */
const notDue = (message: string, at: Date) => refuse('VALIDATION_FAILED', 'NOT_DUE', message, { at: at.toISOString() })

const reminderKey = (taskId: string) => `task.reminder:sla:${taskId}`

async function loadTask(tx: TenantTx, taskId: string) {
  return tx.approvalTask.findFirst({ where: { id: taskId }, include: { step: { include: { route: true } } } })
}
type LoadedTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>

/** The task's timers now, from the stored task, the version's policy and the calendar (BR-SLA-02, BR-SLA-03) */
async function timesOf(tx: TenantTx, organizationId: string, task: LoadedTask): Promise<SlaTimes> {
  const [version, calendar, answered, reminded] = await Promise.all([
    tx.doaVersion.findUniqueOrThrow({ where: { id: task.step.route.doaVersionId }, select: { escalationPolicy: true } }),
    loadBusinessCalendar(tx, organizationId),
    tx.infoRequest.findFirst({ where: { taskId: task.id, answeredAt: { not: null } }, orderBy: { answeredAt: 'desc' }, select: { answeredAt: true } }),
    tx.notification.count({ where: { dedupeKey: reminderKey(task.id) } }),
  ])
  return slaTimes(
    { assignedAt: task.assignedAt, dueAt: task.dueAt, remindAt: task.remindAt, slaMinutes: task.step.slaBusinessMinutes, lastResumedAt: answered?.answeredAt ?? null, reminded: reminded > 0 },
    slaPolicyOf(version.escalationPolicy),
    calendar,
  )
}

/** A task the timers may act on: still OPEN on an active route (a question to the requester pauses it, BR-SLA-03) */
function notActionable(task: LoadedTask): CommandOutcome<never> | null {
  if (task.status === 'INFO_REQUESTED') return refuse('INVALID_STATE_TRANSITION', 'PAUSED', 'the task waits for the requester (SLA paused)')
  if (task.status !== 'OPEN' || task.step.route.status !== 'ACTIVE') return refuse('INVALID_STATE_TRANSITION', 'CLOSED', `the task is ${task.status}`)
  return null
}

async function lockedTask(tx: TenantTx, ctx: Ctx, taskId: string): Promise<LoadedTask | null> {
  const [locked] = await lockRowsForUpdate(tx, 'ApprovalTask', ctx.organizationId, [taskId])
  return locked ? loadTask(tx, taskId) : null
}

/** The step was escalated already: the escalated flag stays on its tasks even after one of them moved (BR-DOA-17) */
async function stepEscalated(tx: TenantTx, stepId: string): Promise<boolean> {
  return (await tx.approvalTask.count({ where: { stepId, escalatedAt: { not: null } } })) > 0
}

const membersOf = (tasks: ReadonlyArray<{ assigneeMemberId: string; principalMemberId: string | null; decidedByMemberId?: string | null }>) => [
  ...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId, t.decidedByMemberId]).filter((m): m is string => Boolean(m))),
]

/**
 * The approver of the next band for a task (BR-SLA-04), with the people who decide the step now left out, and everyone
 * with a part in another step of the route (NEW-47, next-band.ts): who decided one of its other steps, or for whom it
 * was decided, and who holds an open task on one
 */
async function nextBandOf(tx: TenantTx, ctx: Ctx, task: LoadedTask, subject: SubjectFacts): Promise<NextBand> {
  const route = task.step.route
  const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, include: { rules: true } })
  const open = await tx.approvalTask.findMany({ where: { stepId: task.stepId, status: { in: [...OPEN_STATES] } }, select: { assigneeMemberId: true, principalMemberId: true } })
  const others = await tx.approvalTask.findMany({
    where: { step: { routeId: route.id }, stepId: { not: task.stepId }, OR: [{ decidedAt: { not: null } }, { status: { in: [...OPEN_STATES] } }] },
    select: { assigneeMemberId: true, principalMemberId: true, decidedByMemberId: true },
  })
  const deciders = membersOf(open)
  const [org, delegations] = await Promise.all([loadOrgSnapshot(tx), loadDelegations(tx)])
  return nextBandApprover(
    {
      version: versionSnapshotFromRows(version, version.rules),
      ruleCode: route.ruleCode,
      documentType: subject.documentType,
      basisAmountSatang: route.amountSatang,
      chargedDepartmentId: subject.chargedDepartmentId,
      at: ctx.now,
      conflictMemberIds: subject.conflictMemberIds,
      currentDeciderIds: deciders,
      routeMemberIds: membersOf(others),
      routeCreatedAt: route.createdAt,
    },
    org,
    delegations,
  )
}

async function orgAdmins(tx: TenantTx): Promise<string[]> {
  const admins = await tx.roleAssignment.findMany({ where: { role: 'ORG_ADMIN', revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  return [...new Set(admins.map((a) => a.memberId))].sort()
}

// ---------- the plan the job sleeps on ----------

/**
 * Reads the task and returns its timers: what the job sleeps until. A task that is not OPEN has none (FR-NOTI-003 AC3);
 * after the requester answered a question the times are counted from the time that was left (BR-SLA-03), which is
 * what the job approval-task-resume plans with.
 */
export async function planTaskSla(organizationId: string, taskId: string, _now: Date): Promise<TaskSlaPlan> {
  return forTenant(organizationId).$transaction(async (tx) => {
    const task = await loadTask(tx, taskId)
    if (!task) return { taskId, status: 'NOT_FOUND', open: false, remindAt: null, dueAt: null, escalateAt: null }
    if (task.status !== 'OPEN' || task.step.route.status !== 'ACTIVE') return { taskId, status: task.status, open: false, remindAt: null, dueAt: null, escalateAt: null }
    const times = await timesOf(tx, organizationId, task)
    return { taskId, status: task.status, open: true, remindAt: times.remindAt?.toISOString() ?? null, dueAt: times.dueAt.toISOString(), escalateAt: times.escalateAt.toISOString() }
  })
}

/** approval-task-resume (§4.6, BR-SLA-03, FR-INT-009 AC3): the timers of a task the requester just answered */
export const resumeTaskSla = planTaskSla

// ---------- reminder (BR-SLA-02, FR-NOTI-003 AC1) ----------

const RemindInput = z.strictObject({ taskId: z.uuid() })

export const remindTaskSlaCommand = defineCommand({
  name: 'approval_task.sla_remind',
  capability: 'board.pending.view',
  input: RemindInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string; assigneeMemberId: string }>> {
    if (ctx.actor.type !== 'SYSTEM') return systemOnly()
    const task = await lockedTask(tx, ctx, input.taskId)
    if (!task) return refuse('NOT_FOUND', 'NOT_FOUND', 'task not found')
    const blocked = notActionable(task)
    if (blocked) return blocked
    const times = await timesOf(tx, ctx.organizationId, task)
    if (!times.remindAt) return refuse('INVALID_STATE_TRANSITION', 'NOTHING_TO_REMIND', 'reminded already, or the reminder time passed before this assignee got the task')
    if (ctx.now.getTime() < times.remindAt.getTime()) return notDue('not time to remind yet', times.remindAt)
    if (ctx.now.getTime() >= times.dueAt.getTime()) return refuse('INVALID_STATE_TRANSITION', 'PAST_DUE', 'the task is due: the overdue notice takes over')
    const subject = await subjectFacts(tx, task.step.route.subjectType as ApprovalSubject, task.step.route.subjectId)
    return {
      ok: true,
      result: { taskId: task.id, assigneeMemberId: task.assigneeMemberId },
      events: [{ type: 'approval_task.reminded', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectType: subject.type, subjectId: subject.id, via: 'SLA' } }],
      notifications: [
        {
          recipientMemberId: task.assigneeMemberId,
          templateKey: 'task.reminder',
          data: { ...subjectData(subject), taskId: task.id, dueAt: times.dueAt.toISOString() },
          urgency: 'IMMEDIATE',
          dedupeKey: reminderKey(task.id),
          subjectType: subject.type,
          subjectId: subject.id,
        },
      ],
    }
  },
})

/** Handler of the reminder: the assignee is reminded once, part-way through the SLA (GC-SLA-07) */
export async function remindTaskSla(organizationId: string, taskId: string, now: Date): Promise<SlaStepResult> {
  const r = await runCommand(systemCtx(organizationId, now, SLA_JOB), remindTaskSlaCommand, { taskId }, { idempotencyKey: `${SLA_JOB}:remind:${taskId}` })
  return r.ok ? { done: true } : refusalOf(r.error, now)
}

// ---------- overdue (BR-SLA-04 first part, FR-NOTI-003 AC1) ----------

const OverdueInput = z.strictObject({ taskId: z.uuid(), dueAt: z.iso.datetime({ offset: true }) })

export const markTaskOverdueCommand = defineCommand({
  name: 'approval_task.sla_overdue',
  capability: 'board.pending.view',
  input: OverdueInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string; escalateAt: string; nextBandMemberId: string | null }>> {
    if (ctx.actor.type !== 'SYSTEM') return systemOnly()
    const task = await lockedTask(tx, ctx, input.taskId)
    if (!task) return refuse('NOT_FOUND', 'NOT_FOUND', 'task not found')
    const blocked = notActionable(task)
    if (blocked) return blocked
    // The due time the job slept until must still be the task's: an answer to a question moves it (BR-SLA-03)
    if (!task.dueAt || task.dueAt.getTime() !== new Date(input.dueAt).getTime()) return refuse('INVALID_STATE_TRANSITION', 'STALE', 'the due time has moved')
    const times = await timesOf(tx, ctx.organizationId, task)
    if (ctx.now.getTime() < times.dueAt.getTime()) return notDue('not due yet', times.dueAt)
    if (task.overdueAt && task.overdueAt.getTime() >= times.dueAt.getTime()) return refuse('INVALID_STATE_TRANSITION', 'ALREADY_OVERDUE', 'marked overdue already')
    const subject = await subjectFacts(tx, task.step.route.subjectType as ApprovalSubject, task.step.route.subjectId)
    // BR-SLA-04: the approver of the next band hears of it, for acknowledgement — unless the step was escalated already,
    // when that band decides it with the assignee (an answered question gave the task a new due time). The notice says
    // that escalation follows: the band is added as co-assignee at escalateAt on any step of the route (NEW-47).
    const escalated = await stepEscalated(tx, task.stepId)
    const next = escalated ? null : await nextBandOf(tx, ctx, task, subject)
    const ack = next?.kind === 'FOUND' && next.assigneeMemberId !== task.assigneeMemberId ? next.assigneeMemberId : null
    const willEscalate = ack !== null
    await tx.approvalTask.update({ where: { id: task.id }, data: { overdueAt: ctx.now, escalateAt: times.escalateAt } })
    const dueAt = times.dueAt.toISOString()
    const base = { ...subjectData(subject), taskId: task.id, dueAt }
    const notifications: NotificationDraft[] = [
      { recipientMemberId: task.assigneeMemberId, templateKey: 'task.overdue', data: { ...base, role: 'ASSIGNEE' }, urgency: 'IMMEDIATE', dedupeKey: `task.overdue:${task.id}:${dueAt}`, subjectType: subject.type, subjectId: subject.id },
    ]
    // Once per step and due time
    if (ack) {
      notifications.push({
        recipientMemberId: ack,
        templateKey: 'task.overdue',
        data: { ...base, role: 'ACK', willEscalate },
        urgency: 'IMMEDIATE',
        dedupeKey: `task.overdue:ack:${task.stepId}:${dueAt}:${ack}`,
        subjectType: subject.type,
        subjectId: subject.id,
      })
    }
    return {
      ok: true,
      result: { taskId: task.id, escalateAt: times.escalateAt.toISOString(), nextBandMemberId: ack },
      events: [{ type: 'approval_task.overdue', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectType: subject.type, subjectId: subject.id, dueAt, escalateAt: times.escalateAt.toISOString(), nextBandMemberId: ack } }],
      notifications,
    }
  },
})

export type OverdueStepResult = SlaStepResult & { readonly escalateAt: string | null }

/**
 * Handler at dueAt: the task is marked overdue and the assignee (and the next band, for acknowledgement) told. The
 * result names escalateAt while the task stays open and overdue for this due time — marked now or by an earlier run.
 */
export async function markTaskOverdue(organizationId: string, taskId: string, now: Date): Promise<OverdueStepResult> {
  const task = await forTenant(organizationId).approvalTask.findFirst({ where: { id: taskId }, select: { dueAt: true } })
  if (!task?.dueAt) return { done: false, code: 'NOT_FOUND', reason: 'NOT_FOUND', notBefore: null, waitMs: null, escalateAt: null }
  const dueAt = task.dueAt.toISOString()
  const r = await runCommand(systemCtx(organizationId, now, SLA_JOB), markTaskOverdueCommand, { taskId, dueAt }, { idempotencyKey: `${SLA_JOB}:overdue:${taskId}:${dueAt}` })
  const result: SlaStepResult = r.ok ? { done: true } : refusalOf(r.error, now)
  const goesOn = result.done || result.reason === 'ALREADY_OVERDUE'
  const plan = goesOn ? await planTaskSla(organizationId, taskId, now) : null
  return { ...result, escalateAt: plan?.open ? plan.escalateAt : null }
}

// ---------- escalation (BR-SLA-04, FR-NOTI-003 AC2) ----------

const EscalateInput = z.strictObject({ taskId: z.uuid() })

type Role = 'CO_ASSIGNEE' | 'ASSIGNEE' | 'REQUESTER' | 'ADMIN'

export const escalateTaskCommand = defineCommand({
  name: 'approval_task.sla_escalate',
  capability: 'approval.reassign',
  input: EscalateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string; outcome: 'CO_ASSIGNED' | 'NO_NEXT_BAND'; coAssigneeTaskId: string | null; coAssigneeMemberId: string | null }>> {
    if (ctx.actor.type !== 'SYSTEM') return systemOnly()
    const task = await lockedTask(tx, ctx, input.taskId)
    if (!task) return refuse('NOT_FOUND', 'NOT_FOUND', 'task not found')
    const blocked = notActionable(task)
    if (blocked) return blocked
    const times = await timesOf(tx, ctx.organizationId, task)
    if (ctx.now.getTime() < times.escalateAt.getTime()) return notDue('not time to escalate yet', times.escalateAt)
    // A committee or a reviewer step (BR-WF-15) counts per task and adds no co-assignee: no band above stands for a slot
    const slotted = task.step.mode === 'PARALLEL' || task.step.kind === 'REVIEW'
    // Once per step: the escalated flag stays on the tasks of the step even after one of them moved (BR-DOA-17); once per
    // task of a step of several slots
    if (slotted ? task.escalatedAt !== null : await stepEscalated(tx, task.stepId)) return refuse('INVALID_STATE_TRANSITION', 'ALREADY_ESCALATED', 'the step was escalated already')
    const route = task.step.route
    const subject = await subjectFacts(tx, route.subjectType as ApprovalSubject, route.subjectId)

    // A co-assignee joins any step of the route (NEW-47): the first decision on the step cancels its other open tasks
    // (§6.4 "ผู้รับร่วมอีกคนตัดสินแล้ว", src/server/services/approvals/step-complete.ts), so neither task can act on
    // the document after the step moved on; and nobody with a part in another step of the route is added, so no one
    // approves two of its steps (next-band.ts)
    const next: NextBand = slotted ? { kind: 'NONE', reason: 'SLOTTED_STEP', ruleCode: null } : await nextBandOf(tx, ctx, task, subject)

    await tx.approvalTask.update({ where: { id: task.id }, data: { escalatedAt: ctx.now, escalateAt: times.escalateAt, version: { increment: 1 } } })
    const told = new Map<string, { role: Role; taskId: string }>()
    const tell = (memberId: string | null, role: Role, taskId: string) => {
      if (memberId && !told.has(memberId)) told.set(memberId, { role, taskId })
    }
    const notifications: NotificationDraft[] = []
    const events: EventDraft[] = []
    let coTask: { id: string } | null = null
    if (next.kind === 'FOUND') {
      // The approver of the next band joins the step: whoever decides first decides (BR-SLA-04). The new task is born
      // overdue and escalated, so its own SLA run (started by its approval_task.assigned) sends no second overdue
      // notice and escalates nothing again.
      coTask = await tx.approvalTask.create({
        data: {
          organizationId: ctx.organizationId,
          stepId: task.stepId,
          assigneeMemberId: next.assigneeMemberId,
          principalMemberId: next.principalMemberId,
          resolvedFrom: next.resolvedFrom,
          status: 'OPEN',
          assignedAt: ctx.now,
          dueAt: times.dueAt,
          overdueAt: task.overdueAt ?? ctx.now,
          escalateAt: times.escalateAt,
          escalatedAt: ctx.now,
        },
        select: { id: true },
      })
      // The co-assignee's task has its own history from its assignment, and its ActionTokens come with this event
      // (BR-TOK-01): they are revoked when either task is decided or cancelled
      events.push({
        type: 'approval_task.assigned',
        aggregateType: 'ApprovalTask',
        aggregateId: coTask.id,
        data: {
          subjectType: subject.type,
          subjectId: subject.id,
          routeId: route.id,
          stepNo: task.step.stepNo,
          assigneeMemberId: next.assigneeMemberId,
          principalMemberId: next.principalMemberId,
          resolvedFrom: next.resolvedFrom,
          dueAt: times.dueAt.toISOString(),
        },
      })
      tell(next.assigneeMemberId, 'CO_ASSIGNEE', coTask.id)
      tell(task.assigneeMemberId, 'ASSIGNEE', task.id)
      tell(subject.ownerMemberId, 'REQUESTER', task.id)
      // BR-DLG-05: the band holder's delegate conflicts with the document, so the holder keeps it and ORG_ADMIN is told
      if (next.notifyOrgAdmin) {
        for (const admin of await orgAdmins(tx)) {
          notifications.push({
            recipientMemberId: admin,
            templateKey: 'approval_task.delegate_conflict',
            data: { ...subjectData(subject), taskId: coTask.id },
            urgency: 'IMMEDIATE',
            dedupeKey: `approval_task.delegate_conflict:${coTask.id}:${admin}`,
            subjectType: subject.type,
            subjectId: subject.id,
          })
        }
      }
    } else {
      // No band above, or its position is vacant: ORG_ADMIN and the requester are told (BR-SLA-04), with the reason; the
      // holder of a slot too (BR-WF-15)
      if (slotted) tell(task.assigneeMemberId, 'ASSIGNEE', task.id)
      tell(subject.ownerMemberId, 'REQUESTER', task.id)
      for (const admin of await orgAdmins(tx)) tell(admin, 'ADMIN', task.id)
    }
    const outcome = next.kind === 'FOUND' ? 'CO_ASSIGNED' : 'NO_NEXT_BAND'
    const reason = next.kind === 'FOUND' ? null : next.reason
    for (const [memberId, who] of told) {
      notifications.push({
        recipientMemberId: memberId,
        templateKey: 'task.escalated',
        data: { ...subjectData(subject), taskId: who.taskId, role: who.role, outcome, ...(reason ? { reason } : {}), dueAt: times.dueAt.toISOString() },
        urgency: 'IMMEDIATE',
        dedupeKey: `task.escalated:${task.id}:${memberId}`,
        subjectType: subject.type,
        subjectId: subject.id,
      })
    }
    events.unshift({
      type: 'approval_task.escalated',
      aggregateType: 'ApprovalTask',
      aggregateId: task.id,
      // The decision stays under the route's own DOA reference; escalation adds the flag, not a new rule
      doaVersionId: route.doaVersionId,
      doaRuleCode: route.ruleCode,
      data: {
        subjectType: subject.type,
        subjectId: subject.id,
        stepId: task.stepId,
        outcome,
        reason,
        coAssigneeTaskId: coTask?.id ?? null,
        coAssigneeMemberId: next.kind === 'FOUND' ? next.assigneeMemberId : null,
        coAssigneePrincipalMemberId: next.kind === 'FOUND' ? next.principalMemberId : null,
        resolvedFrom: next.kind === 'FOUND' ? next.resolvedFrom : null,
        doaVersionId: route.doaVersionId,
        doaRuleCode: route.ruleCode,
        nextRuleCode: next.ruleCode,
      },
    })
    return {
      ok: true,
      result: { taskId: task.id, outcome, coAssigneeTaskId: coTask?.id ?? null, coAssigneeMemberId: next.kind === 'FOUND' ? next.assigneeMemberId : null },
      events,
      notifications,
    }
  },
})

export type EscalateStepResult = SlaStepResult & { readonly outcome: 'CO_ASSIGNED' | 'NO_NEXT_BAND' | null; readonly coAssigneeTaskId: string | null }

/** Handler at escalateAt: the next band's approver becomes co-assignee, or ORG_ADMIN and the requester are told */
export async function escalateTask(organizationId: string, taskId: string, now: Date): Promise<EscalateStepResult> {
  const r = await runCommand(systemCtx(organizationId, now, SLA_JOB), escalateTaskCommand, { taskId }, { idempotencyKey: `${SLA_JOB}:escalate:${taskId}` })
  return r.ok ? { done: true, outcome: r.data.outcome, coAssigneeTaskId: r.data.coAssigneeTaskId } : { ...refusalOf(r.error, now), outcome: null, coAssigneeTaskId: null }
}
