import { z } from 'zod'
import { businessMinutesBetween } from '@/core/sla'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_HOUR } from '@/lib/constants'
import { authorize, scopesFor, type Principal } from '@/server/authz'
import type { StoredRole } from '@/server/authz/permissions'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate, type LockableTable } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The board "เอกสารค้างที่ใคร" (spec §11.1, FR-VIS-001 AC1 AC2): one row per assignee with their open tasks, the age of
// the oldest in business hours, how many are past their SLA and the average age; tasks waiting for the requester
// (INFO_REQUESTED) are a group of their own. The ages use the business calendar of the SLA engine (§7.8). Who sees
// what follows board.pending.view: everyone their own tasks and the tasks on their own documents, a department head
// the requests charged to their departments (docs/sub-specs/S4.md), EXECUTIVE PROCUREMENT FINANCE AUDITOR the whole
// organization. A task can be reminded by hand at most once an hour per document (approval_task.reminded) — by a
// reader who sees it other than as AUDITOR, who reads only (BR-AUTH-04).

const OPEN = ['OPEN', 'INFO_REQUESTED'] as const
export const BOARD_SUBJECTS = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const
export type BoardSubject = (typeof BOARD_SUBJECTS)[number]

export interface BoardFilter {
  readonly departmentId?: string
  readonly subjectType?: BoardSubject
}

export interface BoardTaskDto {
  readonly taskId: string
  readonly subjectType: string
  readonly subjectId: string
  readonly label: string
  readonly status: 'OPEN' | 'INFO_REQUESTED'
  readonly assignedAt: string
  readonly dueAt: string | null
  /** Business minutes since the task was assigned */
  readonly ageMinutes: number
  readonly overdue: boolean
  /** The purchase order a variance belongs to (the page a reader opens for it); null for other documents */
  readonly poId: string | null
  /** When this document may be reminded by hand again (an hour after the last reminder); null: now (FR-VIS-001 AC2) */
  readonly remindAgainAt: string | null
  /**
   * The reader may remind this task by hand: it waits for a decision and they see it other than as AUDITOR, who reads
   * only (BR-AUTH-04). remindTask checks the same again.
   */
  readonly canRemind: boolean
}

/** What the viewer's board covers (§2.4 board.pending.view): the organization, the departments they head, or their own */
export type BoardScope = 'ORG' | 'DEPT' | 'OWN'

export interface BoardViewDto {
  readonly rows: BoardRowDto[]
  readonly scope: BoardScope
  /** When the ages were counted */
  readonly asOf: string
}

export interface BoardRowDto {
  readonly memberId: string
  readonly name: string
  readonly open: number
  readonly waitingForRequester: number
  readonly overdue: number
  readonly oldestMinutes: number
  readonly averageMinutes: number
  readonly tasks: readonly BoardTaskDto[]
}

/** The documents a principal may see on the board beyond their own tasks, as Prisma conditions on the task ({} = all) */
async function visibleTasks(tx: TenantTx, principal: Principal): Promise<object | null> {
  if (principal.kind !== 'member') return null
  const scopes = scopesFor(principal, 'board.pending.view')
  if (scopes.has('ORG')) return {}
  const memberId = principal.memberId
  const ownRequests = (await tx.request.findMany({ where: { requesterMemberId: memberId }, select: { id: true } })).map((r) => r.id)
  const ownPos = (await tx.purchaseOrder.findMany({ where: { createdById: memberId }, select: { id: true } })).map((p) => p.id)
  const headed = [...principal.headOfDepartmentIds]
  const deptRequests = headed.length ? (await tx.request.findMany({ where: { chargedDepartmentId: { in: headed } }, select: { id: true } })).map((r) => r.id) : []
  return {
    OR: [
      { assigneeMemberId: memberId },
      { principalMemberId: memberId },
      { step: { route: { subjectId: { in: [...ownRequests, ...ownPos, ...deptRequests] } } } },
    ],
  }
}

// ---------- who may remind (BR-AUTH-04) ----------

/**
 * BR-AUTH-04 (§2.2): the AUDITOR reads only. A reminder writes an event and sends a notice, so a member reminds only
 * the tasks they see other than as AUDITOR: their own task or document, a department they head, or another
 * organization-wide role. Whether EXECUTIVE ("ดูอย่างเดียว" in §2.2) may remind is not settled by the spec and waits
 * for the user; until then the board's other readers may.
 */
const READ_ONLY_ROLES: ReadonlySet<StoredRole> = new Set<StoredRole>(['AUDITOR'])

const readsOnlySomewhere = (principal: Principal) => principal.kind === 'member' && [...principal.roles].some((r) => READ_ONLY_ROLES.has(r))

/** The same member without the roles that only read */
function asWriter(principal: Principal): Principal {
  if (principal.kind !== 'member') return principal
  return { ...principal, roles: new Set([...principal.roles].filter((r) => !READ_ONLY_ROLES.has(r))) }
}

/** Of these tasks (all visible to the principal), the ones they may remind; null: every one */
async function remindableTasks(tx: TenantTx, principal: Principal, taskIds: readonly string[]): Promise<ReadonlySet<string> | null> {
  if (!readsOnlySomewhere(principal)) return null
  const writer = await visibleTasks(tx, asWriter(principal))
  if (writer === null || taskIds.length === 0) return new Set()
  if (Object.keys(writer).length === 0) return null
  const rows = await tx.approvalTask.findMany({ where: { AND: [writer, { id: { in: [...taskIds] } }] }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

/** The row a document's reminders queue on: its own, or its purchase order's for a variance */
const LOCKED: Readonly<Record<string, LockableTable>> = { REQUEST: 'Request', PURCHASE_ORDER: 'PurchaseOrder', DOA_VERSION: 'DoaVersion', ORG_AUTHORITY_CHANGE: 'OrgAuthorityChange' }

/**
 * Two people pressing "remind" on one document at once send one reminder (FR-VIS-001 AC2): the document's row is
 * locked before the last reminder is read, so the second waits and then sees the first (READ COMMITTED, INV-PLT-03).
 */
async function lockDocument(tx: TenantTx, organizationId: string, subjectType: string, subjectId: string): Promise<void> {
  if (subjectType === 'VARIANCE') {
    const variance = await tx.variance.findUnique({ where: { id: subjectId }, select: { poId: true } })
    if (variance) await lockRowsForUpdate(tx, 'PurchaseOrder', organizationId, [variance.poId])
    return
  }
  const table = LOCKED[subjectType]
  if (table) await lockRowsForUpdate(tx, table, organizationId, [subjectId])
}

async function labels(tx: TenantTx, tasks: ReadonlyArray<{ subjectType: string; subjectId: string }>): Promise<Map<string, string>> {
  return new Map([...(await documents(tx, tasks))].map(([id, d]) => [id, d.label] as const))
}

/** The label of each document on the board, and the purchase order of a variance */
async function documents(tx: TenantTx, tasks: ReadonlyArray<{ subjectType: string; subjectId: string }>): Promise<Map<string, { label: string; poId: string | null }>> {
  const ids = (type: string) => tasks.filter((t) => t.subjectType === type).map((t) => t.subjectId)
  const [requests, pos, variances, versions, changes] = await Promise.all([
    tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, number: true, title: true } }),
    tx.purchaseOrder.findMany({ where: { id: { in: ids('PURCHASE_ORDER') } }, select: { id: true, number: true } }),
    tx.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, poId: true, po: { select: { number: true } } } }),
    tx.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true } }),
    tx.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true } }),
  ])
  const plain = (label: string): { label: string; poId: string | null } => ({ label, poId: null })
  return new Map<string, { label: string; poId: string | null }>([
    ...requests.map((r) => [r.id, plain(r.number ? `${r.number} ${r.title}` : r.title)] as const),
    ...pos.map((p) => [p.id, plain(p.number ?? '')] as const),
    ...variances.map((v) => [v.id, { label: v.po.number ?? '', poId: v.poId }] as const),
    ...versions.map((v) => [v.id, plain(`${v.code} #${v.versionNo}`)] as const),
    ...changes.map((c) => [c.id, plain(c.kind)] as const),
  ])
}

/** When each document was last reminded within the hour before `now` (approval_task.reminded carries the document) */
async function recentReminders(tx: TenantTx, now: Date): Promise<Map<string, Date>> {
  // the same window remindTask refuses in
  const events = await tx.event.findMany({ where: { type: 'approval_task.reminded', occurredAt: { gt: new Date(now.getTime() - MS_PER_HOUR) } }, select: { occurredAt: true, data: true } })
  const last = new Map<string, Date>()
  for (const e of events) {
    const subjectId = (e.data as { subjectId?: unknown }).subjectId
    if (typeof subjectId !== 'string') continue
    const seen = last.get(subjectId)
    if (!seen || e.occurredAt > seen) last.set(subjectId, e.occurredAt)
  }
  return last
}

/** The board's rows for a principal already allowed board.pending.view; null for a principal who is not a member */
async function boardRows(tx: TenantTx, ctx: Ctx, principal: Principal, filter: BoardFilter): Promise<BoardRowDto[] | null> {
  const scope = await visibleTasks(tx, principal)
  if (scope === null) return null
  const tasks = await tx.approvalTask.findMany({
    where: {
      AND: [
        scope,
        { status: { in: [...OPEN] } },
        ...(filter.subjectType ? [{ step: { route: { subjectType: filter.subjectType } } }] : []),
        ...(filter.departmentId ? [{ assignee: { primaryDepartmentId: filter.departmentId } }] : []),
      ],
    },
    include: { step: { include: { route: { select: { subjectType: true, subjectId: true } } } }, assignee: { select: { id: true, displayNameTh: true } } },
    orderBy: { assignedAt: 'asc' },
  })
  const calendar = await loadBusinessCalendar(tx, ctx.organizationId)
  const named = await documents(
    tx,
    tasks.map((t) => t.step.route),
  )
  const reminded = await recentReminders(tx, ctx.now)
  const remindable = await remindableTasks(
    tx,
    principal,
    tasks.filter((t) => t.status === 'OPEN').map((t) => t.id),
  )
  const rows = new Map<string, { name: string; tasks: BoardTaskDto[] }>()
  for (const t of tasks) {
    const last = reminded.get(t.step.route.subjectId)
    const dto: BoardTaskDto = {
      taskId: t.id,
      subjectType: t.step.route.subjectType,
      subjectId: t.step.route.subjectId,
      label: named.get(t.step.route.subjectId)?.label ?? '',
      status: t.status as 'OPEN' | 'INFO_REQUESTED',
      assignedAt: t.assignedAt.toISOString(),
      dueAt: t.dueAt?.toISOString() ?? null,
      ageMinutes: businessMinutesBetween(t.assignedAt, ctx.now, calendar),
      overdue: t.status === 'OPEN' && t.dueAt !== null && t.dueAt < ctx.now,
      poId: named.get(t.step.route.subjectId)?.poId ?? null,
      remindAgainAt: last ? new Date(last.getTime() + MS_PER_HOUR).toISOString() : null,
      canRemind: t.status === 'OPEN' && (remindable === null || remindable.has(t.id)),
    }
    const row = rows.get(t.assigneeMemberId) ?? { name: t.assignee.displayNameTh, tasks: [] }
    row.tasks.push(dto)
    rows.set(t.assigneeMemberId, row)
  }
  return [...rows]
    .map(([memberId, r]): BoardRowDto => {
      const open = r.tasks.filter((t) => t.status === 'OPEN')
      const ages = open.map((t) => t.ageMinutes)
      return {
        memberId,
        name: r.name,
        open: open.length,
        waitingForRequester: r.tasks.length - open.length,
        overdue: open.filter((t) => t.overdue).length,
        oldestMinutes: ages.length ? Math.max(...ages) : 0,
        averageMinutes: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0,
        tasks: r.tasks,
      }
    })
    .sort((a, b) => b.overdue - a.overdue || b.oldestMinutes - a.oldestMinutes || a.name.localeCompare(b.name, 'th'))
}

export async function pendingBoard(ctx: Ctx, filter: BoardFilter = {}): Promise<Result<BoardRowDto[]>> {
  const db = forTenant(ctx.organizationId)
  return db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'board.pending.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const rows = await boardRows(tx, ctx, allowed.data, filter)
    return rows === null ? err('FORBIDDEN', 'members only') : ok(rows)
  })
}

/** The board's scope for this principal, as the screen states it */
function boardScope(principal: Principal): BoardScope {
  if (principal.kind === 'member' && scopesFor(principal, 'board.pending.view').has('ORG')) return 'ORG'
  return principal.kind === 'member' && principal.headOfDepartmentIds.size > 0 ? 'DEPT' : 'OWN'
}

/** The board page (§9.1 /board/pending): the rows of pendingBoard with what they cover and when the ages were counted */
export async function boardView(ctx: Ctx, filter: BoardFilter = {}): Promise<Result<BoardViewDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'board.pending.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const rows = await boardRows(tx, ctx, allowed.data, filter)
    if (rows === null) return err('FORBIDDEN', 'members only')
    return ok({ rows, scope: boardScope(allowed.data), asOf: ctx.now.toISOString() })
  })
}

// ---------- remind by hand (FR-VIS-001 AC2) ----------

const RemindInput = z.strictObject({ taskId: z.uuid() })

export const remindTaskCommand = defineCommand({
  name: 'approval_task.remind',
  capability: 'board.pending.view',
  input: RemindInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ taskId: string }>> {
    const allowed = await authorize(tx, ctx, 'board.pending.view')
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const scope = await visibleTasks(tx, allowed.data)
    if (scope === null) return { ok: false, error: { code: 'FORBIDDEN', message: 'members only' } }
    const task = await tx.approvalTask.findFirst({ where: { AND: [scope, { id: input.taskId }] }, include: { step: { include: { route: true } } } })
    if (!task) return { ok: false, error: { code: 'NOT_FOUND', message: 'task not found' } }
    // BR-AUTH-04: a task seen only as AUDITOR is read, never reminded
    const remindable = await remindableTasks(tx, allowed.data, [task.id])
    if (remindable !== null && !remindable.has(task.id)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'the auditor reads only: no reminders', details: { capability: 'board.pending.view', reason: 'READ_ONLY' } } }
    }
    if (task.status !== 'OPEN') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'only an open task is reminded', details: { from: task.status, command: 'approval_task.remind' } } }
    // At most once an hour per document, whoever reminds (FR-VIS-001 AC2); the refusal says when it may be sent again.
    // The document is locked first, so reminders pressed at the same moment queue and the second one sees the first.
    await lockDocument(tx, ctx.organizationId, task.step.route.subjectType, task.step.route.subjectId)
    const since = new Date(ctx.now.getTime() - MS_PER_HOUR)
    const recent = await tx.event.findFirst({
      where: { type: 'approval_task.reminded', occurredAt: { gt: since }, data: { path: ['subjectId'], equals: task.step.route.subjectId } },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    })
    if (recent) {
      const nextAt = new Date(recent.occurredAt.getTime() + MS_PER_HOUR).toISOString()
      return { ok: false, error: { code: 'RATE_LIMITED', message: 'this document was reminded within the hour', details: { reason: 'REMINDED_WITHIN_HOUR', nextAt } } }
    }
    const label = (await labels(tx, [task.step.route])).get(task.step.route.subjectId) ?? ''
    return {
      ok: true,
      result: { taskId: task.id },
      events: [{ type: 'approval_task.reminded', aggregateType: 'ApprovalTask', aggregateId: task.id, data: { subjectType: task.step.route.subjectType, subjectId: task.step.route.subjectId, via: 'MANUAL' } }],
      notifications: [
        {
          recipientMemberId: task.assigneeMemberId,
          templateKey: 'task.reminder',
          data: { subjectType: task.step.route.subjectType, subjectId: task.step.route.subjectId, label, taskId: task.id, dueAt: task.dueAt?.toISOString() ?? null },
          urgency: 'IMMEDIATE',
          dedupeKey: `task.reminder:${task.id}:${ctx.now.toISOString()}`,
          subjectType: task.step.route.subjectType,
          subjectId: task.step.route.subjectId,
        },
      ],
    }
  },
})

export function remindTask(ctx: Ctx, input: z.input<typeof RemindInput>, options: RunOptions) {
  return runCommand(ctx, remindTaskCommand, input, options)
}
