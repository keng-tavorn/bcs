import { z } from 'zod'
import { releaseTransfer, reserveTransfer, transferDoaInput, transferIn, transferOut, type TransferKind } from '@/core/budget'
import { amountToSatang } from '@/core/money/dto'
import type { AppError } from '@/core/result'
import { BUDGET_TRANSFER_MACHINE, transition, type BudgetTransferState } from '@/core/state-machines'
import { REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { authorize } from '@/server/authz'
import { applyBudget } from '@/server/budget/ledger'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { closeRoute, startRoute } from '../approvals/route'
import { issueDocumentNumber } from '../numbering'

// Budget transfers and adjustments (S6-15 · FR-BUD-103 · BR-BUD-09 to BR-BUD-11 · ADR-104 · OQ-105): BUDGET_ADMIN, or
// the head of the department whose line gives (or receives, for an increase), drafts a TRANSFER from one line to another
// of the same fiscal year, a DECREASE of one line or an INCREASE of one, and sends it under the BUDGET_TRANSFER rule of
// the DOA in effect: the source line reserves the amount at once (all of it, or BUDGET_INSUFFICIENT), and a DOA with no
// such rule refuses with DOA_NOT_CONFIGURED having reserved nothing. Approved, the reservation leaves the source and the
// amount enters the destination in one transaction, both lines locked by id (INV-BUD-05); rejected, returned or
// cancelled, the reservation comes back. The one who sent it never approves it (SoD of the subject).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'FORBIDDEN'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const Baht = z.string().regex(/^\d{1,13}(\.\d{1,2})?$/)

const CreateInput = z.strictObject({
  kind: z.enum(['TRANSFER', 'INCREASE', 'DECREASE']),
  fromBudgetLineId: z.uuid().nullable().optional(),
  toBudgetLineId: z.uuid().nullable().optional(),
  amount: Baht,
  reason: z.string().trim().min(3).max(REASON_MAX_LENGTH),
})

/** The lines a transfer names, with their department, fiscal year and status */
async function linesOf(tx: TenantTx, ids: ReadonlyArray<string | null>) {
  const wanted = ids.filter((id): id is string => id !== null)
  const rows = await tx.budgetLine.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, departmentId: true, fiscalYearId: true, status: true, fiscalYear: { select: { status: true } } } })
  return new Map(rows.map((r) => [r.id, r]))
}

/** BR-BUD-10: the lines fit the kind, exist, are OPEN in an OPEN fiscal year, differ, and share one fiscal year */
async function checkLines(tx: TenantTx, kind: TransferKind, from: string | null, to: string | null) {
  if ((kind === 'INCREASE') !== (from === null) || (kind === 'DECREASE') !== (to === null)) return fail('VALIDATION_FAILED', 'the lines do not fit the kind', { reason: 'LINES_DO_NOT_FIT_KIND' })
  if (from !== null && from === to) return fail('VALIDATION_FAILED', 'a transfer goes to another line', { field: 'toBudgetLineId', reason: 'SAME_LINE' })
  const lines = await linesOf(tx, [from, to])
  for (const [field, id] of [['fromBudgetLineId', from], ['toBudgetLineId', to]] as const) {
    if (id === null) continue
    const line = lines.get(id)
    if (!line) return fail('VALIDATION_FAILED', 'unknown budget line', { field, reason: 'UNKNOWN' })
    if (line.status !== 'OPEN' || line.fiscalYear.status !== 'OPEN') return fail('VALIDATION_FAILED', 'the budget line is not open', { field, reason: 'LINE_NOT_OPEN' })
  }
  if (from !== null && to !== null && lines.get(from)!.fiscalYearId !== lines.get(to)!.fiscalYearId) return fail('VALIDATION_FAILED', 'both lines are of one fiscal year', { field: 'toBudgetLineId', reason: 'OTHER_FISCAL_YEAR' })
  return { ok: true as const, from: from ? lines.get(from)! : null, to: to ? lines.get(to)! : null }
}

/** The department that decides who may send it and whose approvers decide it: the source's, or the destination's for an increase (BR-BUD-11) */
const departmentOf = (kind: TransferKind, from: { departmentId: string } | null, to: { departmentId: string } | null) => (kind === 'INCREASE' ? to! : from!).departmentId

// ---------- create ----------

export const createTransferCommand = defineCommand({
  name: 'budgetTransfer.create',
  capability: 'budget.transfer.submit',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ transferId: string }>> {
    const member = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!member) return fail('FORBIDDEN', 'only a member sends a budget transfer')
    const from = input.fromBudgetLineId ?? null
    const to = input.toBudgetLineId ?? null
    const lines = await checkLines(tx, input.kind, from, to)
    if (!lines.ok) {
      // A line that is not there is not shown to who may not see it: refuse as the capability would
      const allowedAnywhere = await authorize(tx, ctx, 'budget.transfer.submit')
      return allowedAnywhere.ok ? lines : { ok: false, error: allowedAnywhere.error }
    }
    const allowed = await authorize(tx, ctx, 'budget.transfer.submit', { departmentId: departmentOf(input.kind, lines.from, lines.to) })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const amountSatang = amountToSatang(input.amount)
    if (amountSatang <= 0n) return fail('VALIDATION_FAILED', 'the amount is above zero', { field: 'amount', reason: 'AMOUNT_NOT_POSITIVE' })
    const id = newId()
    await tx.budgetTransfer.create({ data: { id, organizationId: ctx.organizationId, kind: input.kind, fromBudgetLineId: from, toBudgetLineId: to, amountSatang, reason: input.reason, submittedById: member } })
    return {
      ok: true,
      result: { transferId: id },
      events: [{ type: 'budget_transfer.drafted', aggregateType: 'BudgetTransfer', aggregateId: id, data: { kind: input.kind, fromBudgetLineId: from, toBudgetLineId: to, amountSatang: amountSatang.toString() } }],
    }
  },
})

export function createBudgetTransfer(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createTransferCommand, input, options)
}

// ---------- submit (and resubmit after a return) ----------

const IdInput = z.strictObject({ transferId: z.uuid() })

async function lockedTransfer(tx: TenantTx, ctx: Ctx, id: string) {
  const [locked] = await lockRowsForUpdate(tx, 'BudgetTransfer', ctx.organizationId, [id])
  return locked ? tx.budgetTransfer.findUniqueOrThrow({ where: { id } }) : null
}

export const submitTransferCommand = defineCommand({
  name: 'budgetTransfer.submit',
  capability: 'budget.transfer.submit',
  input: IdInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ transferId: string; number: string; routeId: string }>> {
    const row = await lockedTransfer(tx, ctx, input.transferId)
    if (!row) return fail('NOT_FOUND', 'budget transfer not found')
    // Only who drafted it sends it (§6.4)
    if (ctx.actor.type !== 'USER' || ctx.actor.memberId !== row.submittedById) return fail('FORBIDDEN', 'only who drafted the transfer sends it')
    const lines = await checkLines(tx, row.kind, row.fromBudgetLineId, row.toBudgetLineId)
    if (!lines.ok) return lines
    const department = departmentOf(row.kind, lines.from, lines.to)
    const allowed = await authorize(tx, ctx, 'budget.transfer.submit', { departmentId: department })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    const moved = transition(BUDGET_TRANSFER_MACHINE, row.status as BudgetTransferState, 'budgetTransfer.submit')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `budgetTransfer.submit is not allowed from ${row.status}`, { from: row.status, command: 'budgetTransfer.submit' })
    // The number stays with a resubmit (a returned transfer keeps its BT number)
    const number = row.number ?? (await issueDocumentNumber(tx, ctx, { document: 'BT', department: (await tx.department.findUniqueOrThrow({ where: { id: department }, select: { code: true } })).code }))
    // BR-BUD-10: the source reserves the amount first — refused, nothing else happens
    const budgetEvents: EventDraft[] = []
    if (row.kind !== 'INCREASE') {
      const reserved = await applyBudget(tx, ctx, [{ budgetLineId: row.fromBudgetLineId!, document: { type: 'BUDGET_TRANSFER', id: row.id }, run: (s) => reserveTransfer(s, row.id, row.amountSatang) }])
      if (!reserved.ok) return { ok: false, error: reserved.error }
      budgetEvents.push(...reserved.events)
    }
    // BR-BUD-11 under the DOA in effect; no BUDGET_TRANSFER rule → DOA_NOT_CONFIGURED and the reservation rolls back with it
    const doa = transferDoaInput({ kind: row.kind, fromDepartmentId: lines.from?.departmentId ?? null, toDepartmentId: lines.to?.departmentId ?? null, amountSatang: row.amountSatang, submitterMemberId: row.submittedById })
    const route = await startRoute(
      tx,
      ctx,
      { type: 'BUDGET_TRANSFER', id: row.id, label: number },
      { documentType: doa.documentType, amount: doa.amount, requesterMemberId: row.submittedById, chargedDepartmentId: doa.chargedDepartmentId, conflictMemberIds: doa.conflictMemberIds, at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.budgetTransfer.update({ where: { id: row.id }, data: { status: moved.to, number, submittedAt: ctx.now, decidedAt: null, currentRouteId: route.data.routeId, version: { increment: 1 } } })
    return {
      ok: true,
      result: { transferId: row.id, number, routeId: route.data.routeId },
      events: [
        {
          type: 'budget_transfer.submitted',
          aggregateType: 'BudgetTransfer',
          aggregateId: row.id,
          data: { kind: row.kind, fromBudgetLineId: row.fromBudgetLineId, toBudgetLineId: row.toBudgetLineId, amountSatang: row.amountSatang.toString(), number, routeId: route.data.routeId, resubmitted: row.status === 'RETURNED' },
        },
        ...budgetEvents,
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitBudgetTransfer(ctx: Ctx, input: z.input<typeof IdInput>, options: RunOptions) {
  return runCommand(ctx, submitTransferCommand, input, options)
}

// ---------- cancel ----------

export const cancelTransferCommand = defineCommand({
  name: 'budgetTransfer.cancel',
  capability: 'budget.transfer.submit',
  input: IdInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ transferId: string }>> {
    const row = await lockedTransfer(tx, ctx, input.transferId)
    if (!row) return fail('NOT_FOUND', 'budget transfer not found')
    if (ctx.actor.type !== 'USER' || ctx.actor.memberId !== row.submittedById) return fail('FORBIDDEN', 'only who drafted the transfer cancels it')
    const moved = transition(BUDGET_TRANSFER_MACHINE, row.status as BudgetTransferState, 'budgetTransfer.cancel')
    if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `budgetTransfer.cancel is not allowed from ${row.status}`, { from: row.status, command: 'budgetTransfer.cancel' })
    const released = await releaseReservation(tx, ctx, row)
    if (!released.ok) return { ok: false, error: released.error }
    const closed = row.status === 'PENDING_APPROVAL' ? await closeRoute(tx, { type: 'BUDGET_TRANSFER', id: row.id }, 'CANCELLED', 'REQUEST_CANCELLED') : []
    await tx.budgetTransfer.update({ where: { id: row.id }, data: { status: moved.to, decidedAt: ctx.now, version: { increment: 1 } } })
    return {
      ok: true,
      result: { transferId: row.id },
      events: [{ type: 'budget_transfer.cancelled', aggregateType: 'BudgetTransfer', aggregateId: row.id, data: { from: row.status as 'DRAFT' | 'RETURNED' | 'PENDING_APPROVAL' } }, ...released.events, ...closed],
    }
  },
})

export function cancelBudgetTransfer(ctx: Ctx, input: z.input<typeof IdInput>, options: RunOptions) {
  return runCommand(ctx, cancelTransferCommand, input, options)
}

// ---------- what the route came to (the BUDGET_TRANSFER subject adapter) ----------

type Moved = { ok: true; events: EventDraft[] } | { ok: false; error: AppError }

/** Gives the source's reservation back (a return keeps none: the resubmit reserves again) */
async function releaseReservation(tx: TenantTx, ctx: Ctx, row: { id: string; kind: TransferKind; fromBudgetLineId: string | null }): Promise<Moved> {
  if (row.kind === 'INCREASE' || !row.fromBudgetLineId) return { ok: true, events: [] }
  const r = await applyBudget(tx, ctx, [{ budgetLineId: row.fromBudgetLineId, document: { type: 'BUDGET_TRANSFER', id: row.id }, run: (s) => releaseTransfer(s, row.id) }])
  return r.ok ? { ok: true, events: r.events } : r
}

/**
 * The last step approved: the reservation leaves the source (AVAILABLE → OUTSIDE) and the amount enters the destination
 * (OUTSIDE → AVAILABLE) in one transaction; applyBudget locks both lines in ascending id order first (INV-BUD-05)
 */
export async function approveTransfer(tx: TenantTx, ctx: Ctx, transferId: string): Promise<{ ok: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }> {
  const row = await lockedTransfer(tx, ctx, transferId)
  if (!row) return fail('NOT_FOUND', 'budget transfer not found')
  const moved = transition(BUDGET_TRANSFER_MACHINE, row.status as BudgetTransferState, 'budgetTransfer.final_approval')
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `budgetTransfer.final_approval is not allowed from ${row.status}`, { from: row.status, command: 'budgetTransfer.final_approval' })
  const ops = [
    ...(row.fromBudgetLineId ? [{ budgetLineId: row.fromBudgetLineId, document: { type: 'BUDGET_TRANSFER' as const, id: row.id }, run: (s: Parameters<typeof transferOut>[0]) => transferOut(s, row.id) }] : []),
    ...(row.toBudgetLineId ? [{ budgetLineId: row.toBudgetLineId, document: { type: 'BUDGET_TRANSFER' as const, id: row.id }, run: (s: Parameters<typeof transferIn>[0]) => transferIn(s, row.id, row.amountSatang) }] : []),
  ]
  const applied = await applyBudget(tx, ctx, ops)
  if (!applied.ok) return applied
  await tx.budgetTransfer.update({ where: { id: row.id }, data: { status: moved.to, decidedAt: ctx.now, version: { increment: 1 } } })
  return {
    ok: true,
    events: [
      { type: 'budget_transfer.approved', aggregateType: 'BudgetTransfer', aggregateId: row.id, data: { kind: row.kind, fromBudgetLineId: row.fromBudgetLineId, toBudgetLineId: row.toBudgetLineId, amountSatang: row.amountSatang.toString(), number: row.number! } },
      ...applied.events,
    ],
    notifications: [{ recipientMemberId: row.submittedById, templateKey: 'budget.transfer_decided', data: { transferId: row.id, number: row.number, outcome: 'APPROVED' }, urgency: 'IMMEDIATE', dedupeKey: `budget.transfer_decided:${row.id}:APPROVED`, subjectType: 'BUDGET_TRANSFER', subjectId: row.id }],
  }
}

/** A step rejected or returned: the reservation comes back and the sender hears why */
export async function declineTransfer(
  tx: TenantTx,
  ctx: Ctx,
  transferId: string,
  outcome: 'REJECTED' | 'RETURNED',
  reasonCommentId: string | null,
): Promise<{ ok: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }> {
  const row = await lockedTransfer(tx, ctx, transferId)
  if (!row) return fail('NOT_FOUND', 'budget transfer not found')
  const command = outcome === 'REJECTED' ? 'approval.reject' : 'approval.return'
  const moved = transition(BUDGET_TRANSFER_MACHINE, row.status as BudgetTransferState, command)
  if (!moved.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${row.status}`, { from: row.status, command })
  const released = await releaseReservation(tx, ctx, row)
  if (!released.ok) return released
  await tx.budgetTransfer.update({ where: { id: row.id }, data: { status: moved.to, decidedAt: ctx.now, version: { increment: 1 } } })
  return {
    ok: true,
    events: [{ type: outcome === 'REJECTED' ? 'budget_transfer.rejected' : 'budget_transfer.returned', aggregateType: 'BudgetTransfer', aggregateId: row.id, data: { number: row.number!, reasonCommentId } }, ...released.events],
    notifications: [{ recipientMemberId: row.submittedById, templateKey: 'budget.transfer_decided', data: { transferId: row.id, number: row.number, outcome }, urgency: 'IMMEDIATE', dedupeKey: `budget.transfer_decided:${row.id}:${outcome}:${ctx.now.toISOString()}`, subjectType: 'BUDGET_TRANSFER', subjectId: row.id }],
  }
}
