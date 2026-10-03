import { z } from 'zod'
import { businessMinutesBetween } from '@/core/sla'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_HOUR } from '@/lib/constants'
import { authorize, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { loadBusinessCalendar } from '@/server/doa/policy'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'

// The board "เอกสารค้างที่ใคร" (spec §11.1, FR-VIS-001 AC1 AC2): one row per assignee with their open tasks, the age of
// the oldest in business hours, how many are past their SLA and the average age; tasks waiting for the requester
// (INFO_REQUESTED) are a group of their own. The ages use the business calendar of the SLA engine (§7.8). Who sees
// what follows board.pending.view: everyone their own tasks and the tasks on their own documents, a department head
// their departments, EXECUTIVE PROCUREMENT FINANCE AUDITOR the whole organization. A task can be reminded by hand at
// most once an hour per document (approval_task.reminded).

const OPEN = ['OPEN', 'INFO_REQUESTED'] as const
export const BOARD_SUBJECTS = ['REQUEST', 'PURCHASE_ORDER', 'VARIANCE', 'DOA_VERSION', 'ORG_AUTHORITY_CHANGE'] as const

export interface BoardFilter {
  readonly departmentId?: string
  readonly subjectType?: (typeof BOARD_SUBJECTS)[number]
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

/** The documents a principal may see on the board beyond their own tasks, as Prisma conditions on the task */
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

async function labels(tx: TenantTx, tasks: ReadonlyArray<{ subjectType: string; subjectId: string }>): Promise<Map<string, string>> {
  const ids = (type: string) => tasks.filter((t) => t.subjectType === type).map((t) => t.subjectId)
  const [requests, pos, variances, versions, changes] = await Promise.all([
    tx.request.findMany({ where: { id: { in: ids('REQUEST') } }, select: { id: true, number: true, title: true } }),
    tx.purchaseOrder.findMany({ where: { id: { in: ids('PURCHASE_ORDER') } }, select: { id: true, number: true } }),
    tx.variance.findMany({ where: { id: { in: ids('VARIANCE') } }, select: { id: true, po: { select: { number: true } } } }),
    tx.doaVersion.findMany({ where: { id: { in: ids('DOA_VERSION') } }, select: { id: true, code: true, versionNo: true } }),
    tx.orgAuthorityChange.findMany({ where: { id: { in: ids('ORG_AUTHORITY_CHANGE') } }, select: { id: true, kind: true } }),
  ])
  return new Map<string, string>([
    ...requests.map((r) => [r.id, r.number ? `${r.number} ${r.title}` : r.title] as const),
    ...pos.map((p) => [p.id, p.number ?? ''] as const),
    ...variances.map((v) => [v.id, v.po.number ?? ''] as const),
    ...versions.map((v) => [v.id, `${v.code} #${v.versionNo}`] as const),
    ...changes.map((c) => [c.id, c.kind] as const),
  ])
}

export async function pendingBoard(ctx: Ctx, filter: BoardFilter = {}): Promise<Result<BoardRowDto[]>> {
  const db = forTenant(ctx.organizationId)
  return db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'board.pending.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const scope = await visibleTasks(tx, allowed.data)
    if (scope === null) return err('FORBIDDEN', 'members only')
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
    const named = await labels(
      tx,
      tasks.map((t) => t.step.route),
    )
    const rows = new Map<string, { name: string; tasks: BoardTaskDto[] }>()
    for (const t of tasks) {
      const dto: BoardTaskDto = {
        taskId: t.id,
        subjectType: t.step.route.subjectType,
        subjectId: t.step.route.subjectId,
        label: named.get(t.step.route.subjectId) ?? '',
        status: t.status as 'OPEN' | 'INFO_REQUESTED',
        assignedAt: t.assignedAt.toISOString(),
        dueAt: t.dueAt?.toISOString() ?? null,
        ageMinutes: businessMinutesBetween(t.assignedAt, ctx.now, calendar),
        overdue: t.status === 'OPEN' && t.dueAt !== null && t.dueAt < ctx.now,
      }
      const row = rows.get(t.assigneeMemberId) ?? { name: t.assignee.displayNameTh, tasks: [] }
      row.tasks.push(dto)
      rows.set(t.assigneeMemberId, row)
    }
    return ok(
      [...rows]
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
        .sort((a, b) => b.overdue - a.overdue || b.oldestMinutes - a.oldestMinutes || a.name.localeCompare(b.name, 'th')),
    )
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
    if (task.status !== 'OPEN') return { ok: false, error: { code: 'INVALID_STATE_TRANSITION', message: 'only an open task is reminded', details: { from: task.status, command: 'approval_task.remind' } } }
    // At most once an hour per document, whoever reminds (FR-VIS-001 AC2)
    const since = new Date(ctx.now.getTime() - MS_PER_HOUR)
    const recent = await tx.event.count({ where: { type: 'approval_task.reminded', occurredAt: { gt: since }, data: { path: ['subjectId'], equals: task.step.route.subjectId } } })
    if (recent > 0) return { ok: false, error: { code: 'RATE_LIMITED', message: 'this document was reminded within the hour', details: { reason: 'REMINDED_WITHIN_HOUR' } } }
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
