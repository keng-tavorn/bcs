import { z } from 'zod'
import { DOA_VERSION_MACHINE, transition, WORKFLOW_VERSION_MACHINE, type DoaVersionState } from '@/core/state-machines'
import { withdrawVersion } from '@/core/workflow'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { closeRoute, startRoute } from '../approvals/route'

// Withdrawing a version approved but not yet in effect (FR-DOA-104 · BR-DOA-18 · FR-WF-103, S6-07), one rule for DOA
// and workflow versions:
//   - asked by who may send that kind of version (admin.doa.submitForPublish · admin.workflow.submitForPublish) with a
//     reason, while it still waits: a DOA_CHANGE route of its own (routeNo next), the version staying PUBLISHED;
//   - approved — by the approver of DOA_CHANGE, never by who asked (SoD), with the step-up every time — it is WITHDRAWN
//     and the version it was to follow runs on, to the next version still waiting or with no end (withdrawVersion of
//     src/core/workflow); ORG_ADMIN, AUDITOR, its submitter and who asked are told; it enters the policy history;
//   - rejected, it stays PUBLISHED and may be asked again;
//   - still asked when the version takes effect, the request is cancelled with its route (ALREADY_EFFECTIVE), as a
//     decision after that time is refused.

export type WithdrawableKind = 'DOA_VERSION' | 'WORKFLOW_VERSION'

const PREFIX = { DOA_VERSION: 'doa_version', WORKFLOW_VERSION: 'workflow_version' } as const
const AGGREGATE = { DOA_VERSION: 'DoaVersion', WORKFLOW_VERSION: 'WorkflowVersion' } as const
const MACHINE = { DOA_VERSION: DOA_VERSION_MACHINE, WORKFLOW_VERSION: WORKFLOW_VERSION_MACHINE } as const
const COMMAND = {
  DOA_VERSION: { request: 'doa.requestWithdrawal', withdraw: 'doa.withdraw', reject: 'doa.rejectWithdrawal' },
  WORKFLOW_VERSION: { request: 'workflowVersion.requestWithdrawal', withdraw: 'workflowVersion.withdraw', reject: 'workflowVersion.rejectWithdrawal' },
} as const

interface VersionRow {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
  readonly submittedById: string | null
  readonly withdrawalRequestedAt: Date | null
  readonly withdrawalRequestedById: string | null
}

const SELECT = { id: true, code: true, versionNo: true, status: true, effectiveFrom: true, effectiveTo: true, submittedById: true, withdrawalRequestedAt: true, withdrawalRequestedById: true } as const

/** The version, and every version of its code (the periods a withdrawal changes) */
async function versionsOf(tx: TenantTx, kind: WithdrawableKind, id: string): Promise<{ row: VersionRow; all: VersionRow[] } | null> {
  const row: VersionRow | null = kind === 'DOA_VERSION' ? await tx.doaVersion.findFirst({ where: { id }, select: SELECT }) : await tx.workflowVersion.findFirst({ where: { id }, select: SELECT })
  if (!row) return null
  const all: VersionRow[] = kind === 'DOA_VERSION' ? await tx.doaVersion.findMany({ where: { code: row.code }, select: SELECT }) : await tx.workflowVersion.findMany({ where: { code: row.code }, select: SELECT })
  return { row, all }
}

/** A withdrawal waits for its decision: the version is still PUBLISHED and was asked to be withdrawn */
export const withdrawalPending = (v: { readonly status: string; readonly withdrawalRequestedAt: Date | null }) => v.status === 'PUBLISHED' && v.withdrawalRequestedAt !== null

const fail = (code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

// ---------- asking ----------

const RequestInput = z.strictObject({ versionId: z.uuid(), reason: z.string().trim().min(3).max(REASON_MAX_LENGTH) })

function requestCommand(kind: WithdrawableKind, capability: 'admin.doa.submitForPublish' | 'admin.workflow.submitForPublish') {
  return defineCommand({
    name: `${kind === 'DOA_VERSION' ? 'doaVersion' : 'workflowVersion'}.requestWithdrawal`,
    capability,
    input: RequestInput,
    async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; routeId: string; assigneeMemberId: string }>> {
      const allowed = await authorize(tx, ctx, capability)
      if (!allowed.ok) return { ok: false, error: allowed.error }
      const actor = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
      if (!actor) return { ok: false, error: { code: 'FORBIDDEN', message: 'only a member asks' } }
      const [locked] = await lockRowsForUpdate(tx, AGGREGATE[kind], ctx.organizationId, [input.versionId])
      if (!locked) return fail('NOT_FOUND', 'version not found')
      const found = await versionsOf(tx, kind, input.versionId)
      if (!found) return fail('NOT_FOUND', 'version not found')
      const { row } = found
      if (withdrawalPending(row)) return fail('INVALID_STATE_TRANSITION', 'a withdrawal is waiting already', { reason: 'WITHDRAWAL_PENDING', from: row.status })
      const moved = transition(MACHINE[kind], row.status as DoaVersionState, COMMAND[kind].request)
      if (!moved.ok) return fail('INVALID_STATE_TRANSITION', 'only an approved version is withdrawn', { reason: 'NOT_PUBLISHED', from: row.status })
      if (row.effectiveFrom.getTime() <= ctx.now.getTime()) return fail('INVALID_STATE_TRANSITION', 'the version is in effect already', { reason: 'ALREADY_EFFECTIVE' })

      // The route of DOA_CHANGE for who asks, from their department (the root for a member without one)
      const member = await tx.member.findUniqueOrThrow({ where: { id: actor }, select: { primaryDepartmentId: true } })
      const root = await tx.department.findFirst({ where: { parentId: null }, select: { id: true } })
      const departmentId = member.primaryDepartmentId ?? root?.id
      if (!departmentId) return fail('VALIDATION_FAILED', 'the organization has no departments', { reason: 'NO_DEPARTMENT' })
      const route = await startRoute(
        tx,
        ctx,
        { type: kind, id: row.id, label: `${row.code} ฉบับ ${row.versionNo}` },
        { documentType: 'DOA_CHANGE', requesterMemberId: actor, chargedDepartmentId: departmentId, conflictMemberIds: [actor], at: ctx.now },
      )
      if (!route.ok) return { ok: false, error: route.error }
      const reasonCommentId = newId()
      await tx.comment.create({ data: { id: reasonCommentId, organizationId: ctx.organizationId, subjectType: kind, subjectId: row.id, authorMemberId: actor, body: input.reason } })
      const data = { withdrawalRequestedAt: ctx.now, withdrawalRequestedById: actor, withdrawalReason: input.reason, version: { increment: 1 } }
      if (kind === 'DOA_VERSION') await tx.doaVersion.update({ where: { id: row.id }, data })
      else await tx.workflowVersion.update({ where: { id: row.id }, data })
      return {
        ok: true,
        result: { versionId: row.id, routeId: route.data.routeId, assigneeMemberId: route.data.firstTask.assigneeMemberId },
        events: [
          { type: `${PREFIX[kind]}.withdrawal_requested`, aggregateType: AGGREGATE[kind], aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, routeId: route.data.routeId, reasonCommentId } },
          ...route.data.events,
        ],
        notifications: route.data.notifications,
      }
    },
  })
}

export const requestDoaWithdrawalCommand = requestCommand('DOA_VERSION', 'admin.doa.submitForPublish')
export const requestWorkflowWithdrawalCommand = requestCommand('WORKFLOW_VERSION', 'admin.workflow.submitForPublish')

export function requestWithdrawal(ctx: Ctx, kind: WithdrawableKind, input: z.input<typeof RequestInput>, options: RunOptions) {
  return runCommand(ctx, kind === 'DOA_VERSION' ? requestDoaWithdrawalCommand : requestWorkflowWithdrawalCommand, input, options)
}

// ---------- the decision (from policy-decide.ts and the WORKFLOW_VERSION adapter) ----------

/** Who asked for the withdrawal of a version (the conflict of its decision: BR-SOD-06), or null when none waits */
export async function withdrawalRequester(tx: TenantTx, kind: WithdrawableKind, id: string): Promise<string | null> {
  const found = await versionsOf(tx, kind, id)
  return found && withdrawalPending(found.row) ? found.row.withdrawalRequestedById : null
}

/** A decision after the version took effect is refused (FR-DOA-104 AC2): checked before the step-up is used */
export function withdrawalTooLate(v: { readonly effectiveFrom: Date }, now: Date) {
  return v.effectiveFrom.getTime() <= now.getTime() ? fail('INVALID_STATE_TRANSITION', 'the version is in effect already', { reason: 'ALREADY_EFFECTIVE' }) : null
}

export interface WithdrawalOutcome {
  readonly events: EventDraft[]
  readonly notifications: NotificationDraft[]
}

/** Who is told of a withdrawal: ORG_ADMIN, AUDITOR, the version's submitter and who asked (FR-DOA-104 AC3) */
async function toldOfWithdrawal(tx: TenantTx, row: VersionRow): Promise<string[]> {
  const roles = await tx.roleAssignment.findMany({ where: { role: { in: ['ORG_ADMIN', 'AUDITOR'] }, revokedAt: null, member: { status: 'ACTIVE' } }, select: { memberId: true } })
  return [...new Set([...roles.map((r) => r.memberId), ...[row.submittedById, row.withdrawalRequestedById].filter((m): m is string => m !== null)])]
}

/** The withdrawal is approved: WITHDRAWN, and the version it was to follow runs on (GC-WF-39 to GC-WF-41) */
export async function withdrawApprovedVersion(tx: TenantTx, ctx: Ctx, kind: WithdrawableKind, id: string): Promise<WithdrawalOutcome> {
  const found = await versionsOf(tx, kind, id)
  if (!found) throw new Error(`${kind} ${id} not found`)
  const { row, all } = found
  const done = withdrawVersion(all, row.versionNo, ctx.now)
  if (!done.ok) throw new Error(`withdrawal of ${kind} ${id} refused: ${done.error.code}`)
  let previous: VersionRow | null = null
  let previousTo: Date | null = null
  // The withdrawn version first: its period stops counting before the one before it grows into it (doa_no_overlap,
  // workflow_no_overlap)
  const ordered = [...done.data.versions].sort((a, b) => Number(b.id === row.id) - Number(a.id === row.id))
  for (const after of ordered) {
    const before = all.find((v) => v.id === after.id)!
    if (after.id === row.id) {
      const moved = transition(MACHINE[kind], row.status as DoaVersionState, COMMAND[kind].withdraw)
      if (!moved.ok) throw new Error(`${kind} ${id} cannot be withdrawn from ${row.status}`)
      const data = { status: moved.to, withdrawnAt: ctx.now, version: { increment: 1 } }
      if (kind === 'DOA_VERSION') await tx.doaVersion.update({ where: { id: row.id }, data })
      else await tx.workflowVersion.update({ where: { id: row.id }, data })
    } else if ((before.effectiveTo?.getTime() ?? null) !== (after.effectiveTo?.getTime() ?? null)) {
      previous = before
      previousTo = after.effectiveTo
      const data = { effectiveTo: after.effectiveTo, version: { increment: 1 } }
      if (kind === 'DOA_VERSION') await tx.doaVersion.update({ where: { id: before.id }, data })
      else await tx.workflowVersion.update({ where: { id: before.id }, data })
    }
  }
  const told = await toldOfWithdrawal(tx, row)
  return {
    events: [
      {
        type: `${PREFIX[kind]}.withdrawn`,
        aggregateType: AGGREGATE[kind],
        aggregateId: row.id,
        data: { code: row.code, versionNo: row.versionNo, previousVersionId: previous?.id ?? null, effectiveTo: previousTo ? previousTo.toISOString() : null },
      },
    ],
    notifications: told.map((memberId) => ({
      recipientMemberId: memberId,
      templateKey: 'policy.withdrawn',
      data: { kind, versionId: row.id, code: row.code, versionNo: row.versionNo },
      urgency: 'IMMEDIATE' as const,
      dedupeKey: `policy.withdrawn:${row.id}:${memberId}`,
      subjectType: kind,
      subjectId: row.id,
    })),
  }
}

/** The withdrawal is rejected: the version stays PUBLISHED and may be asked again; who asked is told */
export async function rejectWithdrawal(tx: TenantTx, kind: WithdrawableKind, id: string, reasonCommentId: string | null): Promise<WithdrawalOutcome> {
  const found = await versionsOf(tx, kind, id)
  if (!found) throw new Error(`${kind} ${id} not found`)
  const { row } = found
  const moved = transition(MACHINE[kind], row.status as DoaVersionState, COMMAND[kind].reject)
  if (!moved.ok) throw new Error(`${kind} ${id}: the withdrawal cannot be rejected from ${row.status}`)
  const data = { withdrawalRequestedAt: null, withdrawalRequestedById: null, withdrawalReason: null, version: { increment: 1 } }
  if (kind === 'DOA_VERSION') await tx.doaVersion.update({ where: { id: row.id }, data })
  else await tx.workflowVersion.update({ where: { id: row.id }, data })
  return {
    events: [{ type: `${PREFIX[kind]}.withdrawal_rejected`, aggregateType: AGGREGATE[kind], aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, reasonCommentId } }],
    notifications: row.withdrawalRequestedById
      ? [
          {
            recipientMemberId: row.withdrawalRequestedById,
            templateKey: 'policy.withdrawal_rejected',
            data: { kind, versionId: row.id, code: row.code, versionNo: row.versionNo },
            urgency: 'IMMEDIATE',
            dedupeKey: `policy.withdrawal_rejected:${row.id}:${row.withdrawalRequestedAt?.toISOString() ?? ''}`,
            subjectType: kind,
            subjectId: row.id,
          },
        ]
      : [],
  }
}

/**
 * The version takes effect with its withdrawal still asked (the activation jobs, FR-DOA-104 AC2): the request is
 * cancelled with its route and its open tasks (ALREADY_EFFECTIVE); nothing when none waits
 */
export async function cancelWithdrawalOnEffect(tx: TenantTx, kind: WithdrawableKind, id: string): Promise<EventDraft[]> {
  const found = await versionsOf(tx, kind, id)
  if (!found || !withdrawalPending(found.row)) return []
  const { row } = found
  const closed = await closeRoute(tx, { type: kind, id: row.id }, 'CANCELLED', 'ALREADY_EFFECTIVE')
  const data = { withdrawalRequestedAt: null, withdrawalRequestedById: null, withdrawalReason: null, version: { increment: 1 } }
  if (kind === 'DOA_VERSION') await tx.doaVersion.update({ where: { id: row.id }, data })
  else await tx.workflowVersion.update({ where: { id: row.id }, data })
  return [...closed, { type: `${PREFIX[kind]}.withdrawal_cancelled`, aggregateType: AGGREGATE[kind], aggregateId: row.id, data: { code: row.code, versionNo: row.versionNo, reason: 'ALREADY_EFFECTIVE' } }]
}
