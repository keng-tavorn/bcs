import { businessMinutesBetween, type BusinessCalendar } from '@/core/sla'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantDb } from '@/server/db/tenant'
import { businessCalendarOf, businessMinutesWaited, isUuid, membersById, slaPausesOf, type MemberRefDto, type NameDto } from './requests'

// The parts of the tabbed document page (FR-INT-012, §9.10 "หน้าเอกสาร") that the request and PO views do not carry:
// each route step's SLA and its own history for the step cards and their panel (AC3), the open task the reader holds on
// the document for the decision bar (AC4), the POs and receipts of a request (AC2) and of a PO (AC6), and the business
// time a document has taken (AC1). Queries never check permissions (they cannot import authz): the page checks
// request.view or po.view first, and po.view again for every PO of a request before it shows one.

const OPEN_TASK: readonly string[] = ['OPEN', 'INFO_REQUESTED']

export type StepEventWhat = 'ASSIGNED' | 'REMINDED' | 'OVERDUE' | 'ESCALATED' | 'REASSIGNED' | 'DELEGATED' | 'INFO_REQUESTED' | 'INFO_PROVIDED' | 'DECIDED' | 'CLOSED'

/** One thing that happened to a task of a step (§9.10 "แผงขั้น": assigned, reminded, moved, delegated, asked, decided) */
export interface StepEventDto {
  readonly key: string
  readonly what: StepEventWhat
  readonly at: Date
  /** Who it happened to or who did it: the assignee, the delegate, the asker, the decider */
  readonly member: MemberRefDto | null
  /** REASSIGNED and DELEGATED: who had the task before */
  readonly from: MemberRefDto | null
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | null
  readonly channel: string | null
  /** A question or an answer as written */
  readonly note: string | null
}

/** The SLA of the step's first open task: business minutes used of the minutes it has (§9.10 "ใช้ไป 6 จาก 8 ชม.ทำการ") */
export interface StepSlaDto {
  readonly dueAt: Date | null
  readonly usedMinutes: number
  readonly targetMinutes: number | null
  readonly overdue: boolean
}

export interface StepDetailDto {
  readonly stepNo: number
  /** The channel the step was decided through (the deciding task's), null while nobody decided it */
  readonly channel: string | null
  /** null once nobody waits on the step, or without a business calendar */
  readonly sla: StepSlaDto | null
  readonly history: readonly StepEventDto[]
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const dataOf = (data: unknown): Record<string, unknown> => (data && typeof data === 'object' ? (data as Record<string, unknown>) : {})

/**
 * The minutes the task has: what it used and what is left until it is due; a task waiting for the requester's answer
 * keeps what was left when it asked (remainingBusinessMinutes, BR-SLA-03), so a pause never counts against it
 */
export function slaOf(
  calendar: BusinessCalendar | null,
  task: { readonly status: string; readonly assignedAt: Date; readonly dueAt: Date | null; readonly remainingBusinessMinutes: number | null },
  now: Date,
  pauses: Parameters<typeof businessMinutesWaited>[3],
): StepSlaDto | null {
  if (!calendar) return null
  const used = businessMinutesWaited(calendar, task.assignedAt, now, pauses) ?? 0
  const overdue = task.status === 'OPEN' && task.dueAt !== null && task.dueAt.getTime() < now.getTime()
  let left: number | null = null
  if (task.status === 'INFO_REQUESTED' && task.remainingBusinessMinutes !== null) left = task.remainingBusinessMinutes
  else if (task.dueAt) left = overdue ? -businessMinutesBetween(task.dueAt, now, calendar) : businessMinutesBetween(now, task.dueAt, calendar)
  return { dueAt: task.dueAt, usedMinutes: used, targetMinutes: left === null ? null : Math.max(0, used + left), overdue }
}

/** Each step of a route with its SLA, the channel of its decision and its history, by step number */
export async function getRouteStepDetails(ctx: Ctx, routeId: string): Promise<StepDetailDto[]> {
  if (!isUuid(routeId)) return []
  const db = forTenant(ctx.organizationId)
  const steps = await db.approvalStep.findMany({
    where: { routeId },
    orderBy: { stepNo: 'asc' },
    select: {
      stepNo: true,
      tasks: {
        orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, status: true, assigneeMemberId: true, assignedAt: true, dueAt: true, remainingBusinessMinutes: true, decision: true, decidedAt: true, decidedByMemberId: true, channel: true },
      },
    },
  })
  const tasks = steps.flatMap((s) => s.tasks)
  const taskIds = tasks.map((t) => t.id)
  if (taskIds.length === 0) return steps.map((s) => ({ stepNo: s.stepNo, channel: null, sla: null, history: [] }))
  const [calendar, pauses, events, infos] = await Promise.all([
    businessCalendarOf(db, ctx.organizationId),
    slaPausesOf(db, taskIds),
    db.event.findMany({
      where: { aggregateType: 'ApprovalTask', aggregateId: { in: taskIds }, type: { in: ['approval_task.assigned', 'approval_task.reminded', 'approval_task.overdue', 'approval_task.escalated', 'approval_task.reassigned', 'approval_task.decided', 'approval_task.cancelled'] } },
      select: { id: true, type: true, aggregateId: true, occurredAt: true, actorMemberId: true, channel: true, data: true },
      orderBy: { seq: 'asc' },
    }),
    db.infoRequest.findMany({ where: { taskId: { in: taskIds } }, select: { id: true, taskId: true, question: true, askedById: true, askedAt: true, answer: true, answeredById: true, answeredAt: true } }),
  ])
  const taskById = new Map(tasks.map((t) => [t.id, t]))
  const members = await membersById(db, [
    ...tasks.flatMap((t) => [t.assigneeMemberId, t.decidedByMemberId]),
    ...events.flatMap((e) => [e.actorMemberId, str(dataOf(e.data).fromMemberId)]),
    ...infos.flatMap((i) => [i.askedById, i.answeredById]),
  ])
  const who = (id: string | null | undefined) => (id ? (members.get(id) ?? null) : null)
  const now = ctx.now

  const byTask = new Map<string, StepEventDto[]>()
  const add = (taskId: string, entry: StepEventDto) => byTask.set(taskId, [...(byTask.get(taskId) ?? []), entry])
  const blank = { member: null, from: null, decision: null, channel: null, note: null } as const
  for (const e of events) {
    const task = taskById.get(e.aggregateId)
    if (!task) continue
    const data = dataOf(e.data)
    switch (e.type) {
      case 'approval_task.assigned':
        add(task.id, { ...blank, key: e.id, what: 'ASSIGNED', at: e.occurredAt, member: who(task.assigneeMemberId) })
        break
      case 'approval_task.reminded':
        add(task.id, { ...blank, key: e.id, what: 'REMINDED', at: e.occurredAt, member: who(task.assigneeMemberId) })
        break
      case 'approval_task.overdue':
        add(task.id, { ...blank, key: e.id, what: 'OVERDUE', at: e.occurredAt })
        break
      case 'approval_task.escalated':
        add(task.id, { ...blank, key: e.id, what: 'ESCALATED', at: e.occurredAt })
        break
      case 'approval_task.reassigned':
        // The event belongs to the task it moved to; a delegation reads as one (BR-DLG-01), anything else as a move
        add(task.id, { ...blank, key: e.id, what: data.why === 'DELEGATION' ? 'DELEGATED' : 'REASSIGNED', at: e.occurredAt, member: who(task.assigneeMemberId), from: who(str(data.fromMemberId)) })
        break
      case 'approval_task.decided': {
        const decision = data.decision === 'APPROVE' || data.decision === 'RETURN' || data.decision === 'REJECT' ? data.decision : null
        add(task.id, { ...blank, key: e.id, what: 'DECIDED', at: e.occurredAt, member: who(e.actorMemberId ?? task.decidedByMemberId), decision, channel: e.channel })
        break
      }
      case 'approval_task.cancelled':
        // Closed without a decision of its own: the other approver decided first, or the route ended (BR-SLA-04)
        add(task.id, { ...blank, key: e.id, what: 'CLOSED', at: e.occurredAt, member: who(task.assigneeMemberId) })
        break
      default:
        break
    }
  }
  for (const i of infos) {
    add(i.taskId, { ...blank, key: `ask-${i.id}`, what: 'INFO_REQUESTED', at: i.askedAt, member: who(i.askedById), note: i.question })
    if (i.answeredAt) add(i.taskId, { ...blank, key: `answer-${i.id}`, what: 'INFO_PROVIDED', at: i.answeredAt, member: who(i.answeredById), note: i.answer })
  }

  return steps.map((s) => {
    const decided = s.tasks.find((t) => t.decision !== null)
    const open = decided ? undefined : s.tasks.find((t) => OPEN_TASK.includes(t.status))
    const history = s.tasks.flatMap((t) => byTask.get(t.id) ?? []).sort((a, b) => a.at.getTime() - b.at.getTime())
    return {
      stepNo: s.stepNo,
      channel: decided?.channel ?? null,
      sla: open ? slaOf(calendar, open, now, pauses.get(open.id) ?? []) : null,
      history,
    }
  })
}

/**
 * The task the member holds on the document now (OPEN: decidable; INFO_REQUESTED waits for the requester's answer,
 * BR-SLA-03), on its current route; null when there is none. The page still asks approval.decide of the task.
 */
export async function getMyOpenTaskId(ctx: Ctx, subjectType: 'REQUEST' | 'PURCHASE_ORDER', subjectId: string): Promise<string | null> {
  if (ctx.actor.type !== 'USER' || !isUuid(subjectId)) return null
  const db = forTenant(ctx.organizationId)
  const task = await db.approvalTask.findFirst({
    // The assignee, or the delegator a delegate holds it for, who may still decide it (BR-DLG-04)
    where: { OR: [{ assigneeMemberId: ctx.actor.memberId }, { principalMemberId: ctx.actor.memberId }], status: 'OPEN', step: { route: { subjectType, subjectId, status: 'ACTIVE' } } },
    orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  return task?.id ?? null
}

/** A receipt of a PO (§9.10 แท็บ "การรับของ") */
export interface ReceiptRowDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly receivedAt: Date
}

/** A PO that orders lines of a request, with its receipts (§9.10 แท็บ "ใบสั่งซื้อและการรับของ" และการ์ด PO) */
export interface RequestPoDto {
  readonly id: string
  readonly number: string | null
  readonly status: string
  readonly grossSatang: bigint
  readonly supplier: NameDto
  readonly receipts: readonly ReceiptRowDto[]
}

async function receiptsOf(db: TenantDb, poIds: readonly string[]): Promise<Map<string, ReceiptRowDto[]>> {
  const rows = poIds.length
    ? await db.goodsReceipt.findMany({ where: { poId: { in: [...poIds] }, status: { not: 'DRAFT' } }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], select: { id: true, poId: true, number: true, status: true, receivedAt: true } })
    : []
  const byPo = new Map<string, ReceiptRowDto[]>()
  for (const r of rows) byPo.set(r.poId, [...(byPo.get(r.poId) ?? []), { id: r.id, number: r.number, status: r.status, receivedAt: r.receivedAt }])
  return byPo
}

/** The POs ordering any line of the request, oldest first, drafts left out (procurement's work in progress) */
export async function listRequestPurchaseOrders(ctx: Ctx, requestId: string): Promise<RequestPoDto[]> {
  if (!isUuid(requestId)) return []
  const db = forTenant(ctx.organizationId)
  const pos = await db.purchaseOrder.findMany({
    where: { status: { not: 'DRAFT' }, lines: { some: { sources: { some: { requestLine: { requestId } } } } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, number: true, status: true, grossSatang: true, supplier: { select: { nameTh: true, nameEn: true } } },
  })
  const receipts = await receiptsOf(db, pos.map((p) => p.id))
  return pos.map((p) => ({ id: p.id, number: p.number, status: p.status, grossSatang: p.grossSatang, supplier: { th: p.supplier.nameTh, en: p.supplier.nameEn }, receipts: receipts.get(p.id) ?? [] }))
}

/** The receipts of one PO, oldest first */
export async function listPoReceipts(ctx: Ctx, poId: string): Promise<ReceiptRowDto[]> {
  if (!isUuid(poId)) return []
  return (await receiptsOf(forTenant(ctx.organizationId), [poId])).get(poId) ?? []
}

/** An invoice confirmed on a PO (§9.10 แท็บ "ใบกำกับ" of the PO page) */
export interface PoInvoiceRowDto {
  readonly id: string
  readonly invoiceNo: string
  readonly invoiceDate: string
  readonly grossSatang: bigint
  readonly isFinal: boolean
}

export async function listPoInvoices(ctx: Ctx, poId: string): Promise<PoInvoiceRowDto[]> {
  if (!isUuid(poId)) return []
  const rows = await forTenant(ctx.organizationId).invoiceConfirmation.findMany({
    where: { poId },
    orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }],
    select: { id: true, invoiceNo: true, invoiceDate: true, grossSatang: true, isFinal: true },
  })
  return rows.map((r) => ({ id: r.id, invoiceNo: r.invoiceNo, invoiceDate: r.invoiceDate.toISOString().slice(0, 10), grossSatang: r.grossSatang, isFinal: r.isFinal }))
}

/**
 * The business time a document has taken (§9.10 "ใช้เวลา {n} วันทำการ"): from its sending until it ended, or until now,
 * as business days with one decimal (a business day is the calendar's working hours); null without a calendar
 */
export async function businessDaysTaken(ctx: Ctx, from: Date | null, until: Date | null): Promise<number | null> {
  if (!from) return null
  const calendar = await businessCalendarOf(forTenant(ctx.organizationId), ctx.organizationId)
  return calendar ? businessDaysOf(calendar, from, until ?? ctx.now) : null
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

export function businessDaysOf(calendar: BusinessCalendar, from: Date, until: Date): number {
  const perDay = minutesOf(calendar.end) - minutesOf(calendar.start)
  const minutes = until.getTime() > from.getTime() ? businessMinutesBetween(from, until, calendar) : 0
  return perDay > 0 ? Math.round((minutes / perDay) * 10) / 10 : 0
}
