import type { BusinessCalendar } from '@/core/sla'
import { MS_PER_DAY } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { scopeOf } from './insights'
import { APPROVAL_ROWS, FOLLOWING_ROWS, figureOf, MY_TASKS_LOOKBACK_DAYS, onTimeOfQueue, onTimeOfTasks, onTimeWindows, type OnTimeFigure, type OnTimeTask, type QueueLine } from './on-time'
import { countMyRequests, FOLLOWING_OPEN_STATUSES, listMyRequests, myRequestsWhere, type MyRequestRowDto } from './requests'
import { listMyTasks, type InboxTaskDto } from './tasks'

export type { OnTimeCount, OnTimeFigure } from './on-time'

// The figures of the home page (spec §9.10 "หน้าแรก", §11.5, FR-VIS-006): on-time approval tasks and the on-time
// procurement queue over the last 30 days and the 30 before, the requests a member follows, and the tasks waiting for
// their approval. From the transaction tables and Event only (P-8), read in batches per window — never one read per row
// (the lesson of NEW-38); the formulas are ./on-time.ts. The to-do card's counts are each list's own count
// (services/home). Queries never check permissions: the service decides which rows and cards a member gets.

const TASK_ROW = { status: true, dueAt: true, decidedAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } } as const

/** On-time approval tasks of the last 30 days against the 30 before, of the member's tasks (assigned to them, or held for them by a delegate, as the inbox) */
export async function onTimeOfMember(db: TenantTx, memberId: string, now: Date): Promise<OnTimeFigure> {
  const { current, previous } = onTimeWindows(now)
  const tasks = await db.approvalTask.findMany({ where: { dueAt: { gte: previous.from, lt: current.to }, OR: [{ assigneeMemberId: memberId }, { principalMemberId: memberId }] }, select: TASK_ROW })
  return figureOf(onTimeOfTasks(tasks, current, now), onTimeOfTasks(tasks, previous, now))
}

/**
 * The same for the documents of some departments and for the whole organization, from one read of the organization's
 * tasks of both windows: `departments` null for no department row, `org` false for no organization row
 */
export async function onTimeOfOrg(db: TenantTx, now: Date, wants: { readonly departments: readonly string[] | null; readonly org: boolean }): Promise<{ readonly departments: OnTimeFigure | null; readonly org: OnTimeFigure | null }> {
  const { current, previous } = onTimeWindows(now)
  const rows = await db.approvalTask.findMany({ where: { dueAt: { gte: previous.from, lt: current.to } }, select: TASK_ROW })
  const figure = (tasks: readonly OnTimeTask[]) => figureOf(onTimeOfTasks(tasks, current, now), onTimeOfTasks(tasks, previous, now))
  let departments: OnTimeFigure | null = null
  if (wants.departments) {
    const inScope = await scopeOf(
      db,
      { departmentIds: wants.departments, requestTypeId: null },
      rows.map((r) => r.step.route),
    )
    departments = figure(rows.filter((r) => inScope(r.step.route.subjectType, r.step.route.subjectId)))
  }
  return { departments, org: wants.org ? figure(rows) : null }
}

/** The member had an approval task in the last 60 days: the row "งานของฉัน" shows for them (§9.10) */
export async function hadTasksLately(tx: TenantTx, memberId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - MY_TASKS_LOOKBACK_DAYS * MS_PER_DAY)
  const found = await tx.approvalTask.findFirst({ where: { assignedAt: { gte: since }, OR: [{ assigneeMemberId: memberId }, { principalMemberId: memberId }] }, select: { id: true } })
  return found !== null
}

// ---------- the on-time procurement queue ----------


/** On-time procurement queue of the last 30 days against the 30 before, for the whole organization */
export async function onTimeQueue(tx: TenantTx, now: Date, targetMinutes: number, calendar: BusinessCalendar): Promise<OnTimeFigure> {
  const { current, previous } = onTimeWindows(now)
  const approvals = await tx.event.findMany({
    where: { type: 'request.approved', aggregateType: 'Request', occurredAt: { gte: previous.from, lt: current.to } },
    select: { aggregateId: true, occurredAt: true },
    orderBy: { seq: 'asc' },
  })
  // a request approved once: its first approval in the windows
  const approvedAt = new Map<string, Date>()
  for (const a of approvals) if (!approvedAt.has(a.aggregateId)) approvedAt.set(a.aggregateId, a.occurredAt)
  const requestIds = [...approvedAt.keys()]
  const [lines, requests] = requestIds.length
    ? await Promise.all([
        tx.requestLine.findMany({ where: { requestId: { in: requestIds } }, select: { id: true, requestId: true, poSources: { select: { poLine: { select: { poId: true } } } } } }),
        tx.request.findMany({ where: { id: { in: requestIds } }, select: { id: true, cancelledAt: true } }),
      ])
    : [[], []]
  const poIds = [...new Set(lines.flatMap((l) => l.poSources.map((s) => s.poLine.poId)))]
  const submits = poIds.length
    ? await tx.event.groupBy({ by: ['aggregateId'], where: { type: 'po.submitted', aggregateType: 'PurchaseOrder', aggregateId: { in: poIds } }, _min: { occurredAt: true } })
    : []
  const firstSubmit = new Map(submits.map((s) => [s.aggregateId, s._min.occurredAt]))
  const cancelledAt = new Map(requests.map((r) => [r.id, r.cancelledAt]))
  const queue: QueueLine[] = lines.map((l) => {
    const times = l.poSources.flatMap((s) => {
      const at = firstSubmit.get(s.poLine.poId)
      return at ? [at] : []
    })
    const submittedAt = times.reduce<Date | null>((first, at) => (first === null || at < first ? at : first), null)
    return { approvedAt: approvedAt.get(l.requestId)!, submittedAt, cancelledAt: cancelledAt.get(l.requestId) ?? null }
  })
  return figureOf(onTimeOfQueue(queue, current, now, targetMinutes, calendar), onTimeOfQueue(queue, previous, now, targetMinutes, calendar))
}

// ---------- the requests I follow ----------

export interface FollowingDto {
  /** The member's own and followed requests that are not drafts (§11.5) */
  readonly total: number
  /** Of those, the ones still on their way */
  readonly open: number
  /** The five that moved last, each with whom it waits for (FR-INT-008 AC1) */
  readonly rows: readonly MyRequestRowDto[]
}

/**
 * When each request last moved: the latest of its own row and events, its approval tasks being assigned or decided (a
 * step's decision writes the task, not the request), its questions asked or answered, and the events of the POs that
 * order its lines (sent, received). Read once per kind for all the requests.
 */
export async function lastActivityOf(tx: TenantTx, requests: ReadonlyArray<{ readonly id: string; readonly updatedAt: Date }>): Promise<Map<string, Date>> {
  const ids = requests.map((r) => r.id)
  const last = new Map(requests.map((r) => [r.id, r.updatedAt]))
  if (ids.length === 0) return last
  const later = (id: string, at: Date | null | undefined) => {
    const now = last.get(id)
    if (at && now && at > now) last.set(id, at)
  }
  const [events, tasks, questions, sources] = await Promise.all([
    tx.event.groupBy({ by: ['aggregateId'], where: { aggregateType: 'Request', aggregateId: { in: ids } }, _max: { occurredAt: true } }),
    tx.approvalTask.findMany({ where: { step: { route: { subjectType: 'REQUEST', subjectId: { in: ids } } } }, select: { assignedAt: true, decidedAt: true, step: { select: { route: { select: { subjectId: true } } } } } }),
    tx.infoRequest.groupBy({ by: ['requestId'], where: { requestId: { in: ids } }, _max: { askedAt: true, answeredAt: true } }),
    tx.poLineSource.findMany({ where: { requestLine: { requestId: { in: ids } } }, select: { poLine: { select: { poId: true } }, requestLine: { select: { requestId: true } } } }),
  ])
  for (const e of events) later(e.aggregateId, e._max.occurredAt)
  for (const t of tasks) {
    later(t.step.route.subjectId, t.assignedAt)
    later(t.step.route.subjectId, t.decidedAt)
  }
  for (const q of questions) {
    later(q.requestId, q._max.askedAt)
    later(q.requestId, q._max.answeredAt)
  }
  const poIds = [...new Set(sources.map((s) => s.poLine.poId))]
  const poEvents = poIds.length ? await tx.event.groupBy({ by: ['aggregateId'], where: { aggregateType: 'PurchaseOrder', aggregateId: { in: poIds } }, _max: { occurredAt: true } }) : []
  const poLast = new Map(poEvents.map((e) => [e.aggregateId, e._max.occurredAt]))
  for (const s of sources) later(s.requestLine.requestId, poLast.get(s.poLine.poId))
  return last
}

export async function loadFollowing(ctx: Ctx): Promise<FollowingDto> {
  if (ctx.actor.type !== 'USER') return { total: 0, open: 0, rows: [] }
  const db = forTenant(ctx.organizationId)
  const [all, open] = await Promise.all([
    db.request.findMany({ where: myRequestsWhere(ctx.actor.memberId, { scope: 'FOLLOWING' }), select: { id: true, updatedAt: true } }),
    countMyRequests(ctx, { scope: 'FOLLOWING', statuses: FOLLOWING_OPEN_STATUSES }),
  ])
  const last = await db.$transaction((tx) => lastActivityOf(tx, all))
  // the five that moved last; on the same moment, the later id (uuid v7: made later) first
  const latest = [...all]
    .sort((a, b) => last.get(b.id)!.getTime() - last.get(a.id)!.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, FOLLOWING_ROWS)
    .map((r) => r.id)
  const list = latest.length ? await listMyRequests(ctx, { scope: 'FOLLOWING', ids: latest }) : { rows: [] }
  const byId = new Map(list.rows.map((r) => [r.id, r]))
  return { total: all.length, open, rows: latest.flatMap((id) => byId.get(id) ?? []) }
}

// ---------- waiting for my approval ----------

export interface ApprovalsDto {
  /** Every open task of mine: waiting for my decision and waiting for the requester's answer */
  readonly all: { readonly count: number; readonly rows: readonly InboxTaskDto[] }
  readonly overdue: { readonly count: number; readonly rows: readonly InboxTaskDto[] }
  readonly info: { readonly count: number; readonly rows: readonly InboxTaskDto[] }
}

/** Earliest due first, a task without a due time last (§9.10) */
const byDue = (a: InboxTaskDto, b: InboxTaskDto) => (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) || a.assignedAt.getTime() - b.assignedAt.getTime()

/** The tabs of "รอฉันอนุมัติ" (FR-VIS-006 AC5): all, overdue, waiting for the requester, each the inbox's own filter */
export async function loadApprovals(ctx: Ctx): Promise<ApprovalsDto> {
  const [all, overdue, info] = await Promise.all([listMyTasks(ctx), listMyTasks(ctx, { due: 'OVERDUE', limit: APPROVAL_ROWS }), listMyTasks(ctx, { due: 'INFO', limit: APPROVAL_ROWS })])
  const tab = (list: typeof all) => ({ count: list.total, rows: [...list.items].sort(byDue).slice(0, APPROVAL_ROWS) })
  return { all: tab(all), overdue: tab(overdue), info: tab(info) }
}
