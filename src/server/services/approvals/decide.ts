import { z } from 'zod'
import { resolveRoute } from '@/core/doa'
import { checkSod, type SodPolicy } from '@/core/sod'
import { businessMinutesBetween, addBusinessMinutes } from '@/core/sla'
import { REQUEST_MACHINE, TASK_MACHINE, transition, type RequestState, type TaskCommand, type TaskState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar, loadRoutePolicy } from '@/server/doa/policy'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { decidePolicyTask } from './policy-decide'
import { decidePoTask } from '../purchase-orders/decide'
import { decideVarianceTask } from '../receiving/variance-decide'
import { releaseForRequest } from '../requests/budget'
import { closeRoute, taskTimes } from './route'

// Deciding approval tasks (spec §6.4, FR-DOA-004, FR-DOA-005, FR-INT-009 AC3). The task's assignee decides, or the
// delegator when a delegate holds it (BR-DLG-04); the task must still be OPEN; separation of duties is checked again at the moment of deciding (GC-SOD-01, GC-SOD-03).
// Return and reject need a reason (kept in Comment). The last approval moves the document on; a return or a rejection
// ends the route. Every decision event names the DOA version and rule, the channel, the actor and whom they act for.

const MIN_REASON_LENGTH = 3

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

async function lockedTask(tx: TenantTx, ctx: Ctx, taskId: string) {
  const [locked] = await lockRowsForUpdate(tx, 'ApprovalTask', ctx.organizationId, [taskId])
  if (!locked) return null
  return tx.approvalTask.findUniqueOrThrow({ where: { id: taskId }, include: { step: { include: { route: true } } } })
}

type LoadedTask = NonNullable<Awaited<ReturnType<typeof lockedTask>>>

/** Who may act on a task: its assignee and, when a delegate holds it, the delegator (BR-DLG-04). */
const deciders = (task: LoadedTask) => [task.assigneeMemberId, task.principalMemberId].filter((m): m is string => Boolean(m))

/** FR-DOA-004 AC2: a task decided already is refused with who decided it and when. */
async function alreadyDecided(tx: TenantTx, task: LoadedTask, command: TaskCommand) {
  const by = task.decidedByMemberId ? await tx.member.findUnique({ where: { id: task.decidedByMemberId }, select: { displayNameTh: true } }) : null
  return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${task.status}`, {
    from: task.status,
    command,
    ...(by ? { name: by.displayNameTh } : {}),
    ...(task.decidedAt ? { time: task.decidedAt.toISOString() } : {}),
  })
}

function moveTask(task: LoadedTask, command: TaskCommand) {
  const t = transition(TASK_MACHINE, task.status as TaskState, command)
  return t.ok ? t.to : null
}

async function addReason(tx: TenantTx, ctx: Ctx, subjectType: string, subjectId: string, body: string): Promise<string> {
  const id = newId()
  await tx.comment.create({ data: { id, organizationId: ctx.organizationId, subjectType, subjectId, authorMemberId: ctx.actor.type === 'USER' ? ctx.actor.memberId : null, body } })
  return id
}

const notifyRequester = (requesterMemberId: string, templateKey: string, request: { id: string; number: string | null; title: string }, extra: Record<string, unknown> = {}): NotificationDraft => ({
  recipientMemberId: requesterMemberId,
  templateKey,
  data: { requestId: request.id, number: request.number, title: request.title, ...extra },
  urgency: 'IMMEDIATE',
  dedupeKey: `${templateKey}:${request.id}:${String(extra.taskId ?? '')}`,
  subjectType: 'REQUEST',
  subjectId: request.id,
})

// ---------- decide ----------

const DecideInput = z.strictObject({
  taskId: z.uuid(),
  decision: z.enum(['APPROVE', 'RETURN', 'REJECT']),
  reason: z.string().trim().max(REASON_MAX_LENGTH).optional(),
})

const COMMAND_OF = { APPROVE: 'approval.approve', RETURN: 'approval.return', REJECT: 'approval.reject' } as const satisfies Record<string, TaskCommand>

export const decideCommand = defineCommand({
  name: 'approval.decide',
  capability: 'approval.decide',
  input: DecideInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string; documentStatus: string }>> {
    const task = await lockedTask(tx, ctx, input.taskId)
    if (!task) return fail('NOT_FOUND', 'task not found')
    // BR-DLG-04: the delegate and the delegator both may decide; whoever acts first decides
    const allowed = await authorize(tx, ctx, 'approval.decide', { deciderMemberIds: deciders(task) })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const command = COMMAND_OF[input.decision]
    const taskTo = moveTask(task, command)
    if (!taskTo) return alreadyDecided(tx, task, command)
    if (input.decision !== 'APPROVE' && (input.reason ?? '').length < MIN_REASON_LENGTH) return fail('VALIDATION_FAILED', 'a reason is needed', { field: 'reason' })
    const route = task.step.route
    if (route.subjectType === 'DOA_VERSION' || route.subjectType === 'ORG_AUTHORITY_CHANGE') return decidePolicyTask(tx, ctx, task, input, taskTo)
    if (route.subjectType === 'PURCHASE_ORDER') return decidePoTask(tx, ctx, task, input, taskTo)
    if (route.subjectType === 'VARIANCE') return decideVarianceTask(tx, ctx, task, input, taskTo)
    if (route.subjectType !== 'REQUEST') return fail('VALIDATION_FAILED', `${route.subjectType} tasks are decided by their own flow`, { reason: 'SUBJECT' })

    const [lockedRequest] = await lockRowsForUpdate(tx, 'Request', ctx.organizationId, [route.subjectId])
    if (!lockedRequest) return fail('NOT_FOUND', 'request not found')
    const request = await tx.request.findUniqueOrThrow({ where: { id: route.subjectId } })
    const actorMemberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!actorMemberId) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member decides' } }

    // Separation of duties at the moment of deciding: the actor, and the principal when a delegate decides (ADR-038 ข้อ 8)
    const version = await tx.doaVersion.findUniqueOrThrow({ where: { id: route.doaVersionId }, select: { sodPolicy: true } })
    const sodPolicy = version.sodPolicy as unknown as SodPolicy
    for (const who of [actorMemberId, task.principalMemberId].filter((m): m is string => Boolean(m))) {
      const sod = checkSod({ kind: 'DECIDE_APPROVAL', subject: 'REQUEST', actorMemberId: who, requesterMemberIds: [request.requesterMemberId] }, sodPolicy)
      if (!sod.ok) {
        return {
          ok: false,
          error: { code: 'SOD_VIOLATION', message: 'separation of duties', details: { rule: sod.rule } },
          auditEvents: [
            { type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: request.id, data: { rule: sod.rule, action: command, subjectType: 'REQUEST', subjectId: request.id, actorMemberId } },
          ],
        }
      }
    }

    const reasonCommentId = input.reason && input.decision !== 'APPROVE' ? await addReason(tx, ctx, 'Request', request.id, input.reason) : null
    await tx.approvalTask.update({
      where: { id: task.id },
      data: { status: taskTo, decision: input.decision, decidedAt: ctx.now, decidedByMemberId: actorMemberId, channel: ctx.channel, reason: input.reason ?? null, version: { increment: 1 } },
    })
    const events: EventDraft[] = [
      {
        type: 'approval_task.decided',
        aggregateType: 'ApprovalTask',
        aggregateId: task.id,
        data: {
          decision: input.decision,
          subjectType: 'REQUEST',
          subjectId: request.id,
          doaVersionId: route.doaVersionId,
          doaRuleCode: route.ruleCode,
          channel: ctx.channel,
          actorMemberId,
          onBehalfOfMemberId: task.principalMemberId,
          reasonCommentId,
        },
      },
    ]
    const notifications: NotificationDraft[] = []
    await tx.approvalStep.update({ where: { id: task.stepId }, data: { status: 'DONE' } })

    if (input.decision === 'APPROVE') {
      const next = await tx.approvalStep.findFirst({ where: { routeId: route.id, status: 'WAITING' }, orderBy: { stepNo: 'asc' } })
      if (next) {
        // A later step of the same route: its approver is the one the engine chose when the route was made
        const policy = await loadRoutePolicy(tx)
        const again = resolveRoute(
          {
            documentType: 'PURCHASE_REQUEST',
            amount: { netSatang: request.netSatang, vatSatang: request.vatSatang },
            requesterMemberId: request.requesterMemberId,
            chargedDepartmentId: request.chargedDepartmentId,
            conflictMemberIds: [request.requesterMemberId],
            at: route.createdAt,
          },
          policy,
        )
        const step = again.ok ? again.data.steps.find((s) => s.stepNo === next.stepNo) : undefined
        if (!step) return { ok: false, error: { code: 'APPROVER_NOT_FOUND', message: 'the next step has no approver', details: { stepNo: next.stepNo } } }
        const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
        const times = taskTimes(ctx.now, next.slaBusinessMinutes, 0.5, calendar)
        const created = await tx.approvalTask.create({
          data: { organizationId: ctx.organizationId, stepId: next.id, assigneeMemberId: step.assigneeMemberId, principalMemberId: step.principalMemberId, resolvedFrom: step.resolvedFrom, assignedAt: ctx.now, dueAt: times.dueAt, remindAt: times.remindAt },
          select: { id: true },
        })
        await tx.approvalStep.update({ where: { id: next.id }, data: { status: 'ACTIVE' } })
        events.push({
          type: 'approval_task.assigned',
          aggregateType: 'ApprovalTask',
          aggregateId: created.id,
          data: { subjectType: 'REQUEST', subjectId: request.id, routeId: route.id, stepNo: next.stepNo, assigneeMemberId: step.assigneeMemberId, principalMemberId: step.principalMemberId, resolvedFrom: step.resolvedFrom, dueAt: times.dueAt.toISOString() },
        })
        notifications.push({
          recipientMemberId: step.assigneeMemberId,
          templateKey: 'task.assigned',
          data: { subjectType: 'REQUEST', subjectId: request.id, label: request.number ?? request.title, taskId: created.id, dueAt: times.dueAt.toISOString() },
          urgency: 'IMMEDIATE',
          dedupeKey: `task.assigned:${created.id}`,
          subjectType: 'REQUEST',
          subjectId: request.id,
        })
        return { ok: true, result: { taskId: task.id, documentStatus: request.status }, events, notifications }
      }
    }

    // The route ends: approved by the last step, returned or rejected
    const documentCommand = input.decision === 'APPROVE' ? 'request.final_approval' : input.decision === 'RETURN' ? 'approval.return' : 'approval.reject'
    const moved = transition(REQUEST_MACHINE, request.status as RequestState, documentCommand)
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${documentCommand} is not allowed from ${request.status}`, { from: request.status, command: documentCommand })
    events.push(...(await closeRoute(tx, { type: 'REQUEST', id: request.id }, input.decision === 'APPROVE' ? 'COMPLETED' : 'CANCELLED', 'DOCUMENT_DECIDED')))
    await tx.request.update({ where: { id: request.id }, data: { status: moved.to, ...(input.decision === 'APPROVE' ? { approvedAt: ctx.now } : {}), version: { increment: 1 } } })
    if (input.decision === 'APPROVE') {
      events.push({ type: 'request.approved', aggregateType: 'Request', aggregateId: request.id, data: { routeId: route.id, doaVersionId: route.doaVersionId, doaRuleCode: route.ruleCode } })
      notifications.push(notifyRequester(request.requesterMemberId, 'request.approved', request, { taskId: task.id }))
    } else {
      const type = input.decision === 'RETURN' ? 'request.returned' : 'request.rejected'
      events.push({ type, aggregateType: 'Request', aggregateId: request.id, data: { taskId: task.id, reasonCommentId: reasonCommentId! } })
      // §6.4: a rejection gives back all the budget the request reserved; a return keeps it for the resubmit
      if (input.decision === 'REJECT') {
        const lines = await tx.requestLine.findMany({ where: { requestId: request.id }, select: { id: true } })
        const released = await releaseForRequest(tx, ctx, request.id, lines.map((l) => l.id))
        if (!released.ok) return released
        events.push(...released.events)
      }
      // §10.1: a return and a rejection share the template request.decided
      notifications.push(notifyRequester(request.requesterMemberId, 'request.decided', request, { taskId: task.id, decision: input.decision }))
    }
    return { ok: true, result: { taskId: task.id, documentStatus: moved.to }, events, notifications }
  },
})

export function decideTask(ctx: Ctx, input: z.input<typeof DecideInput>, options: RunOptions) {
  return runCommand(ctx, decideCommand, input, options)
}

// ---------- ask the requester for more information (FR-INT-009 AC3) ----------

const AskInput = z.strictObject({ taskId: z.uuid(), question: z.string().trim().min(MIN_REASON_LENGTH).max(REASON_MAX_LENGTH) })

export const requestInfoCommand = defineCommand({
  name: 'approval.request_info',
  capability: 'approval.decide',
  input: AskInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ infoRequestId: string }>> {
    const task = await lockedTask(tx, ctx, input.taskId)
    if (!task) return fail('NOT_FOUND', 'task not found')
    const allowed = await authorize(tx, ctx, 'approval.decide', { deciderMemberIds: deciders(task) })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const to = moveTask(task, 'approval.request_info')
    if (!to) return alreadyDecided(tx, task, 'approval.request_info')
    const request = await tx.request.findUniqueOrThrow({ where: { id: task.step.route.subjectId } })
    const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
    // The SLA pauses: what is left is kept and counted again from the answer (GC-SLA-06)
    const left = task.dueAt ? Math.max(0, businessMinutesBetween(ctx.now, task.dueAt, calendar)) : null
    const infoRequestId = newId()
    const askedById = ctx.actor.type === 'USER' ? ctx.actor.memberId : task.assigneeMemberId
    await tx.infoRequest.create({ data: { id: infoRequestId, organizationId: ctx.organizationId, requestId: request.id, taskId: task.id, askedById, question: input.question, askedAt: ctx.now } })
    await tx.approvalTask.update({ where: { id: task.id }, data: { status: to, remainingBusinessMinutes: left, version: { increment: 1 } } })
    return {
      ok: true,
      result: { infoRequestId },
      events: [{ type: 'request.info_requested', aggregateType: 'Request', aggregateId: request.id, data: { taskId: task.id, infoRequestId } }],
      notifications: [notifyRequester(request.requesterMemberId, 'request.info_requested', request, { taskId: task.id, infoRequestId })],
    }
  },
})

export function requestInfo(ctx: Ctx, input: z.input<typeof AskInput>, options: RunOptions) {
  return runCommand(ctx, requestInfoCommand, input, options)
}

const AnswerInput = z.strictObject({ infoRequestId: z.uuid(), answer: z.string().trim().min(1).max(REASON_MAX_LENGTH) })

export const provideInfoCommand = defineCommand({
  name: 'request.provide_info',
  capability: 'request.submit',
  input: AnswerInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string }>> {
    const info = await tx.infoRequest.findFirst({ where: { id: input.infoRequestId } })
    if (!info) return fail('NOT_FOUND', 'information request not found')
    const task = await lockedTask(tx, ctx, info.taskId)
    if (!task) return fail('NOT_FOUND', 'task not found')
    const request = await tx.request.findUniqueOrThrow({ where: { id: info.requestId } })
    const allowed = await authorize(tx, ctx, 'request.submit', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (info.answeredAt) return fail('INVALID_STATE_TRANSITION', 'already answered', { from: 'ANSWERED', command: 'request.provide_info' })
    const to = moveTask(task, 'request.provide_info')
    if (!to) return alreadyDecided(tx, task, 'request.provide_info')
    const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
    // GC-SLA-06: the task is due after the business time that was left when it paused
    const dueAt = addBusinessMinutes(ctx.now, task.remainingBusinessMinutes ?? task.step.slaBusinessMinutes, calendar)
    const answeredById = ctx.actor.type === 'USER' ? ctx.actor.memberId : request.requesterMemberId
    await tx.infoRequest.update({ where: { id: info.id }, data: { answer: input.answer, answeredAt: ctx.now, answeredById } })
    await tx.approvalTask.update({ where: { id: task.id }, data: { status: to, dueAt, remainingBusinessMinutes: null, version: { increment: 1 } } })
    return {
      ok: true,
      result: { taskId: task.id },
      events: [{ type: 'request.info_provided', aggregateType: 'Request', aggregateId: request.id, data: { taskId: task.id, infoRequestId: info.id } }],
      notifications: [
        {
          recipientMemberId: task.assigneeMemberId,
          templateKey: 'request.info_provided',
          data: { requestId: request.id, number: request.number, title: request.title, taskId: task.id },
          urgency: 'IMMEDIATE',
          dedupeKey: `request.info_provided:${info.id}`,
          subjectType: 'REQUEST',
          subjectId: request.id,
        },
      ],
    }
  },
})

export function provideInfo(ctx: Ctx, input: z.input<typeof AnswerInput>, options: RunOptions) {
  return runCommand(ctx, provideInfoCommand, input, options)
}
