import type { BusinessCalendar } from '@/core/sla'
import { MS_PER_DAY } from '@/lib/constants'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { scopeOf } from './insights'
import { APPROVAL_ROWS, FOLLOWING_ROWS, figureOf, MY_TASKS_LOOKBACK_DAYS, onTimeOfQueue, onTimeOfTasks, onTimeWindows, type OnTimeFigure, type OnTimeTask, type QueueLine } from './on-time'
import { countMyRequests, FOLLOWING_OPEN_STATUSES, listMyRequests, type MyRequestRowDto } from './requests'
import { listMyTasks, type InboxTaskDto } from './tasks'

export type { OnTimeCount, OnTimeFigure } from './on-time'

// The figures of the home page (spec §9.10 "หน้าแรก", §11.5, FR-VIS-006): on-time approval tasks and the on-time
// procurement queue over the last 30 days and the 30 before, the requests a member follows, and the tasks waiting for
// their approval. From the transaction tables and Event only (P-8), read in batches per window — never one read per row
// (the lesson of NEW-38); the formulas are ./on-time.ts. The to-do card's counts are each list's own count
// (services/home). Queries never check permissions: the service decides which rows and cards a member gets.

/** Whose tasks: the member's (assigned to them, or held for them by a delegate, as the inbox), some departments' documents, or all */
export type TaskScope = { readonly kind: 'MEMBER'; readonly memberId: string } | { readonly kind: 'DEPARTMENTS'; readonly departmentIds: readonly string[] } | { readonly kind: 'ORG' }

/** On-time approval tasks of the last 30 days against the 30 before, for one scope */
export async function onTimeTasks(tx: TenantTx, scope: TaskScope, now: Date): Promise<OnTimeFigure> {
  const { current, previous } = onTimeWindows(now)
  const rows = await tx.approvalTask.findMany({
    where: { dueAt: { gte: previous.from, lt: current.to }, ...(scope.kind === 'MEMBER' ? { OR: [{ assigneeMemberId: scope.memberId }, { principalMemberId: scope.memberId }] } : {}) },
    select: { status: true, dueAt: true, decidedAt: true, step: { select: { route: { select: { subjectType: true, subjectId: true } } } } },
  })
  let tasks: readonly OnTimeTask[] = rows
  if (scope.kind === 'DEPARTMENTS') {
    const inScope = await scopeOf(
      tx,
      { departmentIds: scope.departmentIds, requestTypeId: null },
      rows.map((r) => r.step.route),
    )
    tasks = rows.filter((r) => inScope(r.step.route.subjectType, r.step.route.subjectId))
  }
  return figureOf(onTimeOfTasks(tasks, current, now), onTimeOfTasks(tasks, previous, now))
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

export async function loadFollowing(ctx: Ctx): Promise<FollowingDto> {
  const [list, open] = await Promise.all([
    listMyRequests(ctx, { scope: 'FOLLOWING', order: 'ACTIVITY', limit: FOLLOWING_ROWS }),
    countOpenFollowing(ctx),
  ])
  return { total: list.matched, open, rows: list.rows }
}

async function countOpenFollowing(ctx: Ctx): Promise<number> {
  const counts = await Promise.all(FOLLOWING_OPEN_STATUSES.map((status) => countMyRequests(ctx, { scope: 'FOLLOWING', status })))
  return counts.reduce((sum, n) => sum + n, 0)
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
