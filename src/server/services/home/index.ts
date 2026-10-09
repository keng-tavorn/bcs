import { err, ok, type Result } from '@/core/result'
import { queueTargetMinutesOf } from '@/lib/org-settings'
import { isAllowed, loadPrincipal, type Principal } from '@/server/authz'
import type { StoredRole } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { hadTasksLately, loadApprovals, loadFollowing, onTimeOfMember, onTimeOfOrg, onTimeQueue, type ApprovalsDto, type FollowingDto, type OnTimeFigure } from '@/server/queries/home'
import { procurementPoCounts } from '@/server/queries/purchase-orders'
import { countMyRequests } from '@/server/queries/requests'
import { countMyTasks } from '@/server/queries/tasks'
import { countReadyForExport } from '../exports/view'
import { countInvoicesToConfirm } from '../invoices/view'
import { countPoolLines } from '../procurement'
import { countReceivable } from '../receiving/view'
import { reportScope } from '../reports/access'
import { TODO_KEYS, TODO_TONE, type TodoKey, type TodoTone } from './todo-keys'

// The home page "งานของฉัน" (spec §9.10, §11.5, FR-VIS-006): which rows and cards a member gets, and their numbers. Every
// to-do row is the count of the list it links to, read by that list's own count with the same conditions — so a number
// never disagrees with what its list shows (AC2) — and only for a member the list would answer: a list that refuses the
// member never gives them a row. Each card is its own call, so the page loads and fails them one by one (AC6). Read only.

export { TODO_KEYS, TODO_TONE, type TodoKey, type TodoTone } from './todo-keys'

const TONE_ORDER: readonly TodoTone[] = ['DANGER', 'WARN', 'NEUTRAL']

export interface TodoRowDto {
  readonly key: TodoKey
  readonly count: number
  readonly tone: TodoTone
}

/** The rows of "งานอนุมัติทันเวลา" (§9.10) */
export type OnTimeKey = 'MINE' | 'DEPARTMENT' | 'ORG' | 'QUEUE'

export interface OnTimeRowDto {
  readonly key: OnTimeKey
  readonly figure: OnTimeFigure
  /** The department /insights opens on for the row DEPARTMENT, or null for the page's own scope */
  readonly insightsDepartmentId: string | null
}

/** Roles that read the procurement queue's timeliness (§9.10) */
const QUEUE_READERS: readonly StoredRole[] = ['PROCUREMENT', 'EXECUTIVE']

async function memberOf(ctx: Ctx): Promise<Result<Extract<Principal, { kind: 'member' }>>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'the home page is a member’s')
  const principal = await forTenant(ctx.organizationId).$transaction((tx) => loadPrincipal(tx, ctx))
  if (principal.kind !== 'member') return err('FORBIDDEN', 'the home page is a member’s')
  return ok(principal)
}

/**
 * "สิ่งที่ต้องทำ" (AC2): the rows the member may open with more than nothing in them, the most pressing first (overdue,
 * then what waits for the requester, then the rest), the larger count first within each
 */
export interface TodoDto {
  readonly rows: readonly TodoRowDto[]
  /** Open approval tasks of the member's, overdue or not: with none, and no row, nothing waits at all (AC6) */
  readonly openTasks: number
}

export async function homeTodo(ctx: Ctx): Promise<Result<TodoDto>> {
  const member = await memberOf(ctx)
  if (!member.ok) return member
  const p = member.data
  const [tasks, returned, questions, drafts, receiving, pool, pos, invoices, exports] = await Promise.all([
    countMyTasks(ctx),
    countMyRequests(ctx, { scope: 'MINE', status: 'RETURNED' }),
    countMyRequests(ctx, { scope: 'MINE', openQuestion: true }),
    countMyRequests(ctx, { scope: 'MINE', status: 'DRAFT' }),
    countReceivable(ctx),
    isAllowed(p, 'procurement.pool.view') ? countPoolLines(ctx) : null,
    isAllowed(p, 'po.create') ? procurementPoCounts(ctx) : null,
    isAllowed(p, 'invoiceConfirmation.record') ? countInvoicesToConfirm(ctx) : null,
    isAllowed(p, 'export.express') ? countReadyForExport(ctx) : null,
  ])
  // null: a list the member may not open, so no row
  const counts: Readonly<Record<TodoKey, number | null>> = {
    OVERDUE_TASKS: tasks.overdue,
    RETURNED: returned,
    QUESTIONS: questions,
    RECEIVING: receiving,
    POOL: pool,
    PO_APPROVED: pos ? pos.APPROVED : null,
    INVOICES: invoices,
    EXPORTS: exports,
    DRAFTS: drafts,
  }
  const rows = TODO_KEYS.flatMap((key) => {
    const count = counts[key]
    return count !== null && count > 0 ? [{ key, count, tone: TODO_TONE[key] }] : []
  })
  rows.sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone) || b.count - a.count || TODO_KEYS.indexOf(a.key) - TODO_KEYS.indexOf(b.key))
  return ok({ rows, openTasks: tasks.all })
}

/**
 * "งานอนุมัติทันเวลา" (AC3): my tasks for a member who had one in the last 60 days; my departments' for a department head
 * whose report.view reaches them; the organization's for a reader of the whole organization (report.view ORG: FINANCE,
 * PROCUREMENT, EXECUTIVE, AUDITOR); the procurement queue for PROCUREMENT and EXECUTIVE. Every row but mine opens
 * /insights, so it shows only to a member who may open it.
 */
export async function homeOnTime(ctx: Ctx): Promise<Result<readonly OnTimeRowDto[]>> {
  const member = await memberOf(ctx)
  if (!member.ok) return member
  const p = member.data
  const reads = reportScope(p)
  const headed = [...p.headOfDepartmentIds]
  const wantsDepartment = headed.length > 0 && reads !== 'NONE'
  const wantsQueue = reads === null && QUEUE_READERS.some((r) => p.roles.has(r))
  // read only: each figure its own short read, side by side, never one long transaction
  const db = forTenant(ctx.organizationId)
  const [mine, org, queue] = await Promise.all([
    hadTasksLately(db, p.memberId, ctx.now).then((had) => (had ? onTimeOfMember(db, p.memberId, ctx.now) : null)),
    wantsDepartment || reads === null ? onTimeOfOrg(db, ctx.now, { departments: wantsDepartment ? headed : null, org: reads === null }) : null,
    wantsQueue
      ? Promise.all([db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } }), db.$transaction((tx) => loadBusinessCalendar(tx, ctx.organizationId))]).then(([o, calendar]) =>
          onTimeQueue(db, ctx.now, queueTargetMinutesOf(o.settings), calendar),
        )
      : null,
  ])
  const rows: OnTimeRowDto[] = []
  if (mine) rows.push({ key: 'MINE', figure: mine, insightsDepartmentId: null })
  // a reader of the whole organization opens /insights on their department when it is one; a head reads only theirs anyway
  if (org?.departments) rows.push({ key: 'DEPARTMENT', figure: org.departments, insightsDepartmentId: reads === null && headed.length === 1 ? headed[0]! : null })
  if (org?.org) rows.push({ key: 'ORG', figure: org.org, insightsDepartmentId: null })
  if (queue) rows.push({ key: 'QUEUE', figure: queue, insightsDepartmentId: null })
  return ok(rows)
}

/** "ที่ฉันติดตาม" (AC4): every member's own and followed requests */
export async function homeFollowing(ctx: Ctx): Promise<Result<FollowingDto>> {
  const member = await memberOf(ctx)
  if (!member.ok) return member
  return ok(await loadFollowing(ctx))
}

/** "รอฉันอนุมัติ" (AC5): the member's open tasks, theirs and the ones they hold for someone, in three tabs */
export async function homeApprovals(ctx: Ctx): Promise<Result<ApprovalsDto>> {
  const member = await memberOf(ctx)
  if (!member.ok) return member
  return ok(await loadApprovals(ctx))
}
