import { TZDate } from '@date-fns/tz'
import { z } from 'zod'
import { err, ok, type Result } from '@/core/result'
import { dueForFollowUp, FOLLOW_UP_DUE_SOON_MS, FOLLOW_UP_MAX, FOLLOW_UP_VIAS, followUpHold, type FollowUpHold, type FollowUpRelation } from '@/lib/follow-up'
import { newId } from '@/lib/ids'
import { authorize, isAllowed, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requestViewScope } from '../requests/view-scope'

// The follow-up assistant (NEW-124 · ADR-082 · "ผู้ช่วยตามงาน" of docs/reports/bcs-assistants.md): the approval tasks of
// the documents a member follows — a request they asked for or follow (request.follow), a PO they made — that are past
// their due time or come due within a day, each with why it waits, from what the SLA engine and the delegations already
// hold: who has it and on whose behalf, whether its holder set an acting delegate who did not take it (and until when),
// when the SLA job reminded, marked it overdue, escalates or escalated it, and who else decides it since. Nothing here is
// written by an AI, decides, or moves a task; tasks waiting for the requester's answer (SLA paused) are not listed.
//
// approval_task.follow_up sends what a person read and confirmed to the holder of the task only — never to the band
// above or anyone else (the DOA's order is the SLA job's to escalate) — in the app with their words, and by LINE or
// e-mail with the document's number and a link (BR-NOTI-01). Only a member who follows the document sends it (BR-AI-01:
// never an agent, never the system) and does not hold a task of the same step, at most FOLLOW_UPS_PER_TASK_PER_DAY times a task a day and not right after the
// holder was told of it (src/lib/follow-up.ts). Each send is an Event naming who pressed it, without the words.

const SUBJECTS = ['REQUEST', 'PURCHASE_ORDER'] as const
type Subject = (typeof SUBJECTS)[number]
const DELEGATION_LIVE = ['SCHEDULED', 'ACTIVE'] as const
/** A task its holder still has: waiting for a decision, or for the requester's answer */
const HELD = ['OPEN', 'INFO_REQUESTED'] as const
/** The most tasks the list shows, the earliest due first */
const LISTED = 50

type Name = { readonly th: string; readonly en: string | null }
const nameOf = (m: { displayNameTh: string; displayNameEn: string | null }): Name => ({ th: m.displayNameTh, en: m.displayNameEn })

export interface FollowUpDto {
  readonly taskId: string
  readonly document: { readonly type: Subject; readonly id: string; readonly number: string | null; readonly title: string; readonly href: string }
  readonly relation: FollowUpRelation
  readonly assignee: { readonly id: string; readonly name: Name }
  /** The task is held by an acting delegate for this member (BR-DLG-04), with the end of the acting period when known */
  readonly onBehalfOf: { readonly id: string; readonly name: Name; readonly until: Date | null } | null
  /** The holder set an acting delegate for now who did not take this task: the period's end */
  readonly holderAwayUntil: Date | null
  readonly dueAt: Date
  readonly overdue: boolean
  /** The SLA job's reminder, part-way through the SLA (BR-SLA-02) */
  readonly slaRemindedAt: Date | null
  /** Marked overdue and its holder told (BR-SLA-04) */
  readonly overdueAt: Date | null
  /** Escalation still to come: when the SLA job escalates it */
  readonly escalatesAt: Date | null
  readonly escalatedAt: Date | null
  /** Who decides the step with the holder since it was escalated (the next band's approver) */
  readonly coAssignees: readonly Name[]
  /** Nudges sent today, whoever sent them, and the last one */
  readonly today: { readonly count: number; readonly lastAt: Date; readonly lastById: string | null; readonly lastBy: Name | null } | null
  /** Why a nudge may not go now, and when it may; null: it may */
  readonly hold: FollowUpHold | null
}

export interface FollowUpsDto {
  readonly items: readonly FollowUpDto[]
  /** When the list was read */
  readonly asOf: Date
}

interface Followed {
  readonly type: Subject
  readonly id: string
  readonly number: string | null
  readonly title: string
  readonly relation: FollowUpRelation
}

const hrefOf = (type: Subject, id: string) => (type === 'REQUEST' ? `/requests/${id}` : `/procurement/pos/${id}`)

/**
 * The documents the member follows — requests asked for or followed, POs made — waiting for approval; or, for `only`,
 * that one document whatever its state (the list reads only open tasks of active routes, the command the task's state)
 */
async function followedDocuments(tx: TenantTx, me: string, only?: string): Promise<Followed[]> {
  const ids = only ? { id: only } : { status: 'PENDING_APPROVAL' as const }
  // one query at a time: they share the transaction's connection
  const requests = await tx.request.findMany({
    where: { ...ids, OR: [{ requesterMemberId: me }, { followers: { some: { memberId: me } } }] },
    select: { id: true, number: true, title: true, requesterMemberId: true },
  })
  const pos = await tx.purchaseOrder.findMany({ where: { ...ids, createdById: me }, select: { id: true, number: true, supplier: { select: { nameTh: true } } } })
  return [
    ...requests.map((r): Followed => ({ type: 'REQUEST', id: r.id, number: r.number, title: r.title, relation: r.requesterMemberId === me ? 'REQUESTER' : 'FOLLOWER' })),
    ...pos.map((p): Followed => ({ type: 'PURCHASE_ORDER', id: p.id, number: p.number, title: p.supplier.nameTh, relation: 'BUYER' })),
  ]
}

type Member = Extract<Principal, { kind: 'member' }>

/**
 * BR-AUTH-04: the AUDITOR reads only, so a follow that stands on that role alone sends nothing (as the board's reminder,
 * src/server/services/board). Following makes a member an owner of the request (request.view OWN), so the question is
 * whether they could read it without their follow and without AUDITOR: assigned to it, heading its department, or
 * another role of the whole organization.
 */
async function followsAsWriter(tx: TenantTx, principal: Member, doc: Followed): Promise<boolean> {
  if (doc.relation !== 'FOLLOWER' || !principal.roles.has('AUDITOR')) return true
  const scope = await requestViewScope(tx, doc.id)
  if (!scope) return false
  const writer: Member = { ...principal, roles: new Set([...principal.roles].filter((r) => r !== 'AUDITOR')) }
  return isAllowed(writer, 'request.view', { ...scope, ownerMemberIds: (scope.ownerMemberIds ?? []).filter((m) => m !== principal.memberId) })
}

/** How the member follows one document; null: they do not */
async function relationTo(tx: TenantTx, me: string, type: string, id: string): Promise<Followed | null> {
  if (!(SUBJECTS as readonly string[]).includes(type)) return null
  const [doc] = (await followedDocuments(tx, me, id)).filter((d) => d.type === type)
  return doc ?? null
}

/** The organization's day around `now`: when it started and when the next one starts */
async function dayOf(tx: TenantTx, organizationId: string, now: Date): Promise<{ start: Date; next: Date }> {
  const { timezone } = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } })
  const local = new TZDate(now.getTime(), timezone)
  const start = new TZDate(local.getFullYear(), local.getMonth(), local.getDate(), 0, 0, timezone)
  // the next midnight by the calendar, not 24 hours on (a zone may shift its clock)
  const next = new TZDate(local.getFullYear(), local.getMonth(), local.getDate() + 1, 0, 0, timezone)
  return { start: new Date(start.getTime()), next: new Date(next.getTime()) }
}

interface TaskRow {
  readonly id: string
  readonly stepId: string
  readonly slotNo: number
  readonly assigneeMemberId: string
  readonly principalMemberId: string | null
  readonly assignedAt: Date
  readonly dueAt: Date | null
  readonly overdueAt: Date | null
  readonly escalateAt: Date | null
  readonly escalatedAt: Date | null
}

/** What the SLA job and the board told each task's holder, and the nudges of today: one read for every task */
async function toldOf(tx: TenantTx, tasks: readonly TaskRow[], dayStart: Date) {
  const taskIds = tasks.map((t) => t.id)
  const reminders = await tx.event.findMany({ where: { type: 'approval_task.reminded', aggregateId: { in: taskIds } }, select: { aggregateId: true, occurredAt: true, data: true } })
  const nudges = await tx.event.findMany({
    where: { type: 'approval_task.followed_up', aggregateId: { in: taskIds }, occurredAt: { gte: dayStart } },
    orderBy: { occurredAt: 'asc' },
    select: { aggregateId: true, occurredAt: true, actorMemberId: true },
  })
  const latest = (rows: ReadonlyArray<{ occurredAt: Date }>) => rows.reduce<Date | null>((at, r) => (!at || r.occurredAt > at ? r.occurredAt : at), null)
  return (task: TaskRow) => {
    const own = reminders.filter((r) => r.aggregateId === task.id)
    const sla = own.filter((r) => (r.data as { via?: unknown }).via === 'SLA')
    const today = nudges.filter((n) => n.aggregateId === task.id)
    // The holder was told of the task when it was given to them, reminded (by the SLA job or from the board), marked
    // overdue or escalated: a nudge right after any of these would say again what they were just told
    const told = [task.assignedAt, latest(own), task.overdueAt, task.escalatedAt].filter((d): d is Date => d !== null)
    return {
      slaRemindedAt: latest(sla),
      lastToldAt: told.reduce<Date | null>((at, d) => (!at || d > at ? d : at), null),
      today,
    }
  }
}

/** Every open task due soon or overdue on the documents followed, held by someone other than the member */
async function followUpsOf(tx: TenantTx, ctx: Ctx, principal: Member, only?: string): Promise<FollowUpDto[]> {
  const me = principal.memberId
  const docs: Followed[] = []
  // one query at a time: they share the transaction's connection
  for (const doc of await followedDocuments(tx, me, only)) if (await followsAsWriter(tx, principal, doc)) docs.push(doc)
  if (docs.length === 0) return []
  const soon = new Date(ctx.now.getTime() + FOLLOW_UP_DUE_SOON_MS)
  const due = await tx.approvalTask.findMany({
    where: {
      status: 'OPEN',
      dueAt: { not: null, lte: soon },
      // not mine, nor held for me (a task without a delegator has no principal: NULL must not drop it)
      assigneeMemberId: { not: me },
      OR: [{ principalMemberId: null }, { principalMemberId: { not: me } }],
      step: { route: { status: 'ACTIVE', OR: SUBJECTS.map((type) => ({ subjectType: type, subjectId: { in: docs.filter((d) => d.type === type).map((d) => d.id) } })) } },
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
    take: LISTED,
    select: {
      id: true,
      stepId: true,
      slotNo: true,
      assigneeMemberId: true,
      principalMemberId: true,
      assignedAt: true,
      dueAt: true,
      overdueAt: true,
      escalateAt: true,
      escalatedAt: true,
      step: { select: { route: { select: { subjectType: true, subjectId: true } } } },
    },
  })
  // Not the steps the member decides too (a slot of its own, or the co-assignee the SLA job added): theirs to decide, not
  // to nudge — the DOA's order stays as it is
  const mine = due.length
    ? await tx.approvalTask.findMany({ where: { stepId: { in: [...new Set(due.map((t) => t.stepId))] }, status: { in: [...HELD] }, OR: [{ assigneeMemberId: me }, { principalMemberId: me }] }, select: { stepId: true } })
    : []
  const tasks = due.filter((t) => !mine.some((m) => m.stepId === t.stepId))
  if (tasks.length === 0) return []
  const day = await dayOf(tx, ctx.organizationId, ctx.now)
  const told = await toldOf(tx, tasks, day.start)

  // Who decides each escalated step with its holder: the other open task of the same step and slot the SLA job added
  const escalatedSteps = [...new Set(tasks.filter((t) => t.escalatedAt).map((t) => t.stepId))]
  const partners = escalatedSteps.length
    ? await tx.approvalTask.findMany({ where: { stepId: { in: escalatedSteps }, status: 'OPEN', escalatedAt: { not: null } }, select: { id: true, stepId: true, slotNo: true, assigneeMemberId: true } })
    : []

  // The acting periods that hold now (BR-DLG-03): of the holders (set, yet the task stayed with them) and of the members
  // a delegate holds a task for. The reason of a delegation is never read: it may say why someone is away.
  const people = [...new Set(tasks.flatMap((t) => [t.assigneeMemberId, t.principalMemberId]).filter((m): m is string => m !== null))]
  const delegations = await tx.delegation.findMany({
    where: { delegatorMemberId: { in: people }, status: { in: [...DELEGATION_LIVE] }, revokedAt: null, startsAt: { lte: ctx.now }, endsAt: { gt: ctx.now } },
    select: { delegatorMemberId: true, delegateMemberId: true, endsAt: true },
  })
  const senders = tasks.flatMap((t) => told(t).today.map((n) => n.actorMemberId)).filter((m): m is string => m !== null)
  const members = await tx.member.findMany({ where: { id: { in: [...new Set([...people, ...partners.map((p) => p.assigneeMemberId), ...senders])] } }, select: { id: true, displayNameTh: true, displayNameEn: true } })
  const named = new Map(members.map((m) => [m.id, nameOf(m)]))
  const byDoc = new Map(docs.map((d) => [`${d.type}:${d.id}`, d]))

  return tasks.flatMap((t): FollowUpDto[] => {
    const doc = byDoc.get(`${t.step.route.subjectType}:${t.step.route.subjectId}`)
    if (!doc || !dueForFollowUp(t.dueAt, ctx.now)) return []
    const facts = told(t)
    const last = facts.today.at(-1)
    const acting = t.principalMemberId ? delegations.find((d) => d.delegatorMemberId === t.principalMemberId && d.delegateMemberId === t.assigneeMemberId) : undefined
    const away = delegations.filter((d) => d.delegatorMemberId === t.assigneeMemberId).sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0]
    const coAssignees = partners.filter((p) => p.stepId === t.stepId && p.slotNo === t.slotNo && p.id !== t.id && p.assigneeMemberId !== t.assigneeMemberId).map((p) => named.get(p.assigneeMemberId)!)
    return [
      {
        taskId: t.id,
        document: { type: doc.type, id: doc.id, number: doc.number, title: doc.title, href: hrefOf(doc.type, doc.id) },
        relation: doc.relation,
        assignee: { id: t.assigneeMemberId, name: named.get(t.assigneeMemberId)! },
        onBehalfOf: t.principalMemberId ? { id: t.principalMemberId, name: named.get(t.principalMemberId)!, until: acting?.endsAt ?? null } : null,
        holderAwayUntil: away?.endsAt ?? null,
        dueAt: t.dueAt,
        overdue: t.dueAt.getTime() <= ctx.now.getTime(),
        slaRemindedAt: facts.slaRemindedAt,
        overdueAt: t.overdueAt,
        escalatesAt: !t.escalatedAt && t.escalateAt && t.escalateAt > ctx.now ? t.escalateAt : null,
        escalatedAt: t.escalatedAt,
        coAssignees,
        today: last ? { count: facts.today.length, lastAt: last.occurredAt, lastById: last.actorMemberId, lastBy: last.actorMemberId ? (named.get(last.actorMemberId) ?? null) : null } : null,
        hold: followUpHold({ now: ctx.now, nextDayStart: day.next, sentToday: facts.today.length, lastToldAt: facts.lastToldAt }),
      },
    ]
  })
}

/**
 * The follow-up list of the member (FR-VIS-001 AC4): every member reads their own (board.pending.view's OWN), and only
 * the documents they follow; `subjectId` narrows it to one document (its page's panel)
 */
export async function listFollowUps(ctx: Ctx, filter: { readonly subjectId?: string } = {}): Promise<Result<FollowUpsDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'the follow-up list is a member’s')
  const subjectId = filter.subjectId && z.uuid().safeParse(filter.subjectId).success ? filter.subjectId : undefined
  if (filter.subjectId && !subjectId) return ok({ items: [], asOf: ctx.now })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'board.pending.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    if (allowed.data.kind !== 'member') return err('FORBIDDEN', 'the follow-up list is a member’s')
    return ok({ items: await followUpsOf(tx, ctx, allowed.data, subjectId), asOf: ctx.now })
  })
}

// ---------- approval_task.follow_up ----------

const FollowUpInput = z.strictObject({
  taskId: z.uuid(),
  /** LINE: the usual way of a task's notice (the app's push first, LINE, then e-mail) · EMAIL: e-mail only */
  via: z.enum(FOLLOW_UP_VIAS),
  text: z.string().trim().min(1).max(FOLLOW_UP_MAX),
})

export interface SentFollowUp {
  readonly taskId: string
  readonly recipientMemberId: string
  readonly via: (typeof FOLLOW_UP_VIAS)[number]
}

const fail = (code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED' | 'RATE_LIMITED', message: string, details?: Record<string, unknown>): CommandOutcome<never> => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) },
})

/** The notice of a nudge by the way chosen: task.follow_up goes as a task's notice goes, task.follow_up_email by e-mail */
export const FOLLOW_UP_TEMPLATE = { LINE: 'task.follow_up', EMAIL: 'task.follow_up_email' } as const

export const sendFollowUpCommand = defineCommand({
  name: 'approval_task.follow_up',
  capability: 'board.pending.view',
  input: FollowUpInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<SentFollowUp>> {
    // BR-AI-01: a person presses send; an agent or a job never does
    if (ctx.actor.type !== 'USER') return fail('FORBIDDEN', 'only a member sends a nudge')
    const allowed = await authorize(tx, ctx, 'board.pending.view')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (allowed.data.kind !== 'member') return fail('FORBIDDEN', 'only a member sends a nudge')
    const principal = allowed.data
    const me = principal.memberId
    // Two nudges pressed at once queue on the task, so the second sees the first (READ COMMITTED, INV-PLT-03)
    const [locked] = await lockRowsForUpdate(tx, 'ApprovalTask', ctx.organizationId, [input.taskId])
    if (!locked) return fail('NOT_FOUND', 'task not found')
    const task = await tx.approvalTask.findUniqueOrThrow({
      where: { id: input.taskId },
      select: {
        id: true,
        stepId: true,
        slotNo: true,
        status: true,
        assigneeMemberId: true,
        principalMemberId: true,
        assignedAt: true,
        dueAt: true,
        overdueAt: true,
        escalateAt: true,
        escalatedAt: true,
        assignee: { select: { status: true } },
        step: { select: { route: { select: { status: true, subjectType: true, subjectId: true } } } },
      },
    })
    const route = task.step.route
    // Only who follows the document: its requester or a follower of a request, the buyer who made a PO
    const doc = await relationTo(tx, me, route.subjectType, route.subjectId)
    if (!doc) return fail('FORBIDDEN', 'only who follows the document nudges its approvers', { reason: 'NOT_FOLLOWER', capability: 'board.pending.view' })
    if (!(await followsAsWriter(tx, principal, doc))) return fail('FORBIDDEN', 'the auditor reads only: no nudges', { reason: 'READ_ONLY', capability: 'board.pending.view' })
    // Not a task of a step the member decides too (this one, another slot, or the co-assignee's): the DOA's order stays
    const holds = await tx.approvalTask.count({ where: { stepId: task.stepId, status: { in: [...HELD] }, OR: [{ assigneeMemberId: me }, { principalMemberId: me }] } })
    if (holds > 0) return fail('FORBIDDEN', 'the step is yours to decide', { reason: 'OWN_TASK' })
    if (task.status !== 'OPEN' || route.status !== 'ACTIVE') {
      return fail('INVALID_STATE_TRANSITION', `approval_task.follow_up is not allowed from ${task.status}`, { from: task.status, command: 'approval_task.follow_up', ...(task.status === 'INFO_REQUESTED' ? { reason: 'WAITS_FOR_REQUESTER' } : {}) })
    }
    if (!dueForFollowUp(task.dueAt, ctx.now)) return fail('VALIDATION_FAILED', 'only a task past its due time or due within a day is nudged', { field: 'taskId', reason: 'NOT_DUE_SOON' })
    if (task.assignee.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 'the holder of the task is not active', { field: 'taskId', reason: 'HOLDER_INACTIVE' })
    const day = await dayOf(tx, ctx.organizationId, ctx.now)
    const facts = (await toldOf(tx, [task], day.start))(task)
    const hold = followUpHold({ now: ctx.now, nextDayStart: day.next, sentToday: facts.today.length, lastToldAt: facts.lastToldAt })
    if (hold) return fail('RATE_LIMITED', hold.reason === 'SENT_TODAY' ? 'the task was nudged today' : 'its holder was just told of it', { reason: hold.reason, nextAt: hold.nextAt.toISOString() })

    const sender = await tx.member.findUniqueOrThrow({ where: { id: me }, select: { displayNameTh: true, displayNameEn: true } })
    const overdue = task.dueAt.getTime() <= ctx.now.getTime()
    const notification: NotificationDraft = {
      recipientMemberId: task.assigneeMemberId,
      templateKey: FOLLOW_UP_TEMPLATE[input.via],
      data: {
        subjectType: doc.type,
        subjectId: doc.id,
        number: doc.number,
        taskId: task.id,
        dueAt: task.dueAt.toISOString(),
        overdue,
        relation: doc.relation,
        senderTh: sender.displayNameTh,
        senderEn: sender.displayNameEn,
        text: input.text,
      },
      urgency: 'IMMEDIATE',
      // One notice per send; the command's idempotency key keeps a resend from writing a second one
      dedupeKey: `task.follow_up:${task.id}:${newId()}`,
      subjectType: doc.type,
      subjectId: doc.id,
    }
    return {
      ok: true,
      result: { taskId: task.id, recipientMemberId: task.assigneeMemberId, via: input.via },
      events: [
        {
          type: 'approval_task.followed_up',
          aggregateType: 'ApprovalTask',
          aggregateId: task.id,
          // who pressed send is the event's actor; the words stay in the holder's notice, never here or in a log
          data: { subjectType: doc.type, subjectId: doc.id, recipientMemberId: task.assigneeMemberId, via: input.via, relation: doc.relation, overdue },
        },
      ],
      notifications: [notification],
    }
  },
})

export function sendFollowUp(ctx: Ctx, input: z.input<typeof FollowUpInput>, options: RunOptions) {
  return runCommand(ctx, sendFollowUpCommand, input, options)
}

