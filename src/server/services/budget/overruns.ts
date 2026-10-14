import { z } from 'zod'
import { earmarkOverrun, overrunDoaInput } from '@/core/budget'
import { lineNetsBeforeVat } from '@/core/money/math'
import type { AppError } from '@/core/result'
import { BUDGET_OVERRUN_MACHINE, transition, type BudgetOverrunCommand, type BudgetOverrunState } from '@/core/state-machines'
import { rateFor, taxDateOf } from '@/core/vat'
import { MS_PER_DAY, REASON_MAX_LENGTH } from '@/lib/constants'
import { newId } from '@/lib/ids'
import { s6SettingsOf } from '@/lib/org-settings'
import { authorize } from '@/server/authz'
import { applyBudget, budgetDomainError } from '@/server/budget/ledger'
import { systemCtx, type Ctx } from '@/server/context'
import { listTaxRates } from '@/server/db/lookups'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { closeRoute, startRoute } from '../approvals/route'
import { issueDocumentNumber } from '../numbering'
import { resolveBudgetLine } from '../requests/budget'
import { lapse, liveOverruns } from './overrun-use'

// Over-budget approval (S6-16 · FR-BUD-101 · BR-BUD-12 to BR-BUD-15 · ADR-105 · OQ-104): the requester of a draft or a
// returned request whose budget line has not enough asks for the shortfall X = M − available (M: what the request still
// has to reserve on the line) with a reason, under the OVER_BUDGET rule of the DOA in effect — a DOA with no such rule
// refuses with DOA_NOT_CONFIGURED. While it waits, the request's amount and budget line are locked. Approved, X enters the
// line and is earmarked for the request in one transaction (BR-BUD-13) for `budget.overrunLapseDays` days; the request's
// submit uses it (./overrun-use.ts, BR-BUD-14), or it lapses and X leaves the line (BR-BUD-15). The requester never
// approves it (SoD of the subject); its approvers read the source request (request.view ASSIGNED).

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'FORBIDDEN' | 'TAX_RATE_NOT_CONFIGURED'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** The days before an approved overrun lapses on which the requester is reminded (BR-BUD-15) */
export const OVERRUN_LAPSING_NOTICE_DAYS = 2

// ---------- what the request needs ----------

export interface OverrunNeed {
  readonly line: { readonly id: string; readonly code: string; readonly nameTh: string; readonly departmentId: string; readonly departmentCode: string }
  /** M: the request's lines before VAT on the line, less what they reserve there already */
  readonly needSatang: bigint
  readonly availableSatang: bigint
}

/**
 * BR-BUD-12: the budget line a draft or returned request would reserve on (as its submit resolves it), what it still
 * needs there and what the line has available now. The line is OPEN; the amounts are before VAT at today's rate.
 */
export async function overrunNeed(tx: TenantTx, ctx: Ctx, requestId: string): Promise<{ ok: true; need: OverrunNeed } | { ok: false; error: AppError }> {
  const request = await tx.request.findFirst({
    where: { id: requestId },
    select: { id: true, status: true, documentType: true, requesterMemberId: true, budgetLineId: true, priceIncludesVat: true, lines: { orderBy: { lineNo: 'asc' }, select: { id: true, quantity: true, unitPriceSatang: true, vatable: true } } },
  })
  if (!request) return fail('NOT_FOUND', 'request not found')
  if (request.documentType !== 'PURCHASE_REQUEST' || (request.status !== 'DRAFT' && request.status !== 'RETURNED')) {
    return fail('INVALID_STATE_TRANSITION', 'only a draft or a returned request asks for over-budget approval', { from: request.status, command: 'budgetOverrun.submit' })
  }
  if (request.lines.length === 0) return fail('VALIDATION_FAILED', 'a request needs at least one line', { field: 'lines', reason: 'NO_LINES' })
  const taxDate = taxDateOf(ctx.now)
  const rate = rateFor(taxDate, await listTaxRates())
  if (!rate.ok) return fail('TAX_RATE_NOT_CONFIGURED', 'no VAT rate covers the tax date', { date: taxDate })
  const resolved = await resolveBudgetLine(tx, ctx, request, taxDate)
  if (!resolved.ok) return resolved
  const line = await tx.budgetLine.findUniqueOrThrow({
    where: { id: resolved.line.id },
    select: { id: true, code: true, nameTh: true, status: true, departmentId: true, department: { select: { code: true } }, balance: { select: { availableSatang: true } } },
  })
  if (line.status !== 'OPEN') return fail('VALIDATION_FAILED', 'the budget line is not open', { field: 'budgetLineId', reason: 'LINE_NOT_OPEN' })
  const nets = lineNetsBeforeVat(
    request.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
    rate.rateBp,
    request.priceIncludesVat,
  )
  const held = await tx.budgetAllocation.aggregate({ where: { budgetLineId: line.id, sourceType: 'REQUEST_LINE', sourceId: { in: request.lines.map((l) => l.id) } }, _sum: { reservedSatang: true } })
  const needSatang = nets.reduce((a, b) => a + b, 0n) - (held._sum.reservedSatang ?? 0n)
  return {
    ok: true,
    need: {
      line: { id: line.id, code: line.code, nameTh: line.nameTh, departmentId: line.departmentId, departmentCode: line.department.code },
      needSatang,
      availableSatang: line.balance?.availableSatang ?? 0n,
    },
  }
}

// ---------- submit ----------

const SubmitInput = z.strictObject({ requestId: z.uuid(), reason: z.string().trim().min(3).max(REASON_MAX_LENGTH) })

export const submitOverrunCommand = defineCommand({
  name: 'budgetOverrun.submit',
  capability: 'budget.overrun.submit',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ overrunId: string; number: string; routeId: string; shortfall: string }>> {
    const member = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    if (!member) return fail('FORBIDDEN', 'only a member asks for over-budget approval')
    const [locked] = await lockRowsForUpdate(tx, 'Request', ctx.organizationId, [input.requestId])
    if (!locked) return fail('NOT_FOUND', 'request not found')
    const request = await tx.request.findUniqueOrThrow({ where: { id: locked }, select: { id: true, requesterMemberId: true, title: true } })
    // OQ-104: the requester only (OWN, never a follower)
    const allowed = await authorize(tx, ctx, 'budget.overrun.submit', { ownerMemberIds: [request.requesterMemberId] })
    if (!allowed.ok) return { ok: false, error: allowed.error }
    if (member !== request.requesterMemberId) return fail('FORBIDDEN', 'only the requester asks for over-budget approval', { capability: 'budget.overrun.submit' })
    if ((await liveOverruns(tx, ctx, request.id)).length) return fail('INVALID_STATE_TRANSITION', 'the request has an over-budget approval already', { reason: 'OVERRUN_EXISTS' })
    const needed = await overrunNeed(tx, ctx, request.id)
    if (!needed.ok) return needed
    const { line, needSatang, availableSatang } = needed.need
    const doa = overrunDoaInput({ needSatang, availableSatang, lineDepartmentId: line.departmentId, requesterMemberId: request.requesterMemberId })
    if (!doa.ok) return { ok: false, error: budgetDomainError(doa.error) }
    const id = newId()
    const number = await issueDocumentNumber(tx, ctx, { document: 'OB', department: line.departmentCode })
    await tx.budgetOverrun.create({
      data: { id, organizationId: ctx.organizationId, number, requestId: request.id, budgetLineId: line.id, requestNetSatang: needSatang, shortfallSatang: doa.input.amount.netSatang, reason: input.reason, submittedById: member, submittedAt: ctx.now },
    })
    // BR-BUD-12 under the DOA in effect; no OVER_BUDGET rule → DOA_NOT_CONFIGURED and the overrun rolls back with it
    const route = await startRoute(
      tx,
      ctx,
      { type: 'BUDGET_OVERRUN', id, label: number },
      { documentType: doa.input.documentType, amount: doa.input.amount, requesterMemberId: request.requesterMemberId, chargedDepartmentId: doa.input.chargedDepartmentId, conflictMemberIds: doa.input.conflictMemberIds, at: ctx.now },
    )
    if (!route.ok) return { ok: false, error: route.error }
    await tx.budgetOverrun.update({ where: { id }, data: { currentRouteId: route.data.routeId } })
    return {
      ok: true,
      result: { overrunId: id, number, routeId: route.data.routeId, shortfall: doa.input.amount.netSatang.toString() },
      events: [
        {
          type: 'budget_overrun.submitted',
          aggregateType: 'BudgetOverrun',
          aggregateId: id,
          data: { requestId: request.id, budgetLineId: line.id, number, requestNetSatang: needSatang.toString(), shortfallSatang: doa.input.amount.netSatang.toString(), routeId: route.data.routeId },
        },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitBudgetOverrun(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitOverrunCommand, input, options)
}

// ---------- cancel ----------

const IdInput = z.strictObject({ overrunId: z.uuid() })

async function lockedOverrun(tx: TenantTx, ctx: Ctx, id: string) {
  const [locked] = await lockRowsForUpdate(tx, 'BudgetOverrun', ctx.organizationId, [id])
  return locked ? tx.budgetOverrun.findUniqueOrThrow({ where: { id: locked } }) : null
}

const move = (status: string, command: BudgetOverrunCommand) => {
  const t = transition(BUDGET_OVERRUN_MACHINE, status as BudgetOverrunState, command)
  return t.ok ? ({ ok: true, to: t.to } as const) : fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${status}`, { from: status, command })
}

export const cancelOverrunCommand = defineCommand({
  name: 'budgetOverrun.cancel',
  capability: 'budget.overrun.submit',
  input: IdInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ overrunId: string }>> {
    const row = await lockedOverrun(tx, ctx, input.overrunId)
    if (!row) return fail('NOT_FOUND', 'over-budget approval not found')
    if (ctx.actor.type !== 'USER' || ctx.actor.memberId !== row.submittedById) return fail('FORBIDDEN', 'only who asked cancels it', { capability: 'budget.overrun.submit' })
    const moved = move(row.status, 'budgetOverrun.cancel')
    if (!moved.ok) return moved
    // Approved and not used: the earmark comes back and X leaves the line (BR-BUD-15)
    if (row.status === 'APPROVED') {
      const lapsed = await lapse(tx, ctx, row, 'budgetOverrun.cancel', 'REQUESTER')
      return lapsed.ok ? { ok: true, result: { overrunId: row.id }, events: lapsed.events } : lapsed
    }
    const closed = await closeRoute(tx, { type: 'BUDGET_OVERRUN', id: row.id }, 'CANCELLED', 'REQUEST_CANCELLED')
    await tx.budgetOverrun.update({ where: { id: row.id }, data: { status: moved.to, version: { increment: 1 } } })
    return { ok: true, result: { overrunId: row.id }, events: [{ type: 'budget_overrun.cancelled', aggregateType: 'BudgetOverrun', aggregateId: row.id, data: { number: row.number, by: 'REQUESTER' } }, ...closed] }
  },
})

export function cancelBudgetOverrun(ctx: Ctx, input: z.input<typeof IdInput>, options: RunOptions) {
  return runCommand(ctx, cancelOverrunCommand, input, options)
}

// ---------- what the route came to (the BUDGET_OVERRUN subject adapter) ----------

type Decided = { ok: true; events: EventDraft[]; notifications: NotificationDraft[] } | { ok: false; error: AppError }

const decidedNotice = (row: { id: string; number: string; requestId: string; submittedById: string }, outcome: 'APPROVED' | 'REJECTED' | 'RETURNED', ctx: Ctx, lapsesOn?: string): NotificationDraft => ({
  recipientMemberId: row.submittedById,
  templateKey: 'budget.overrun_decided',
  data: { overrunId: row.id, number: row.number, requestId: row.requestId, outcome, ...(lapsesOn ? { lapsesOn } : {}) },
  urgency: 'IMMEDIATE',
  dedupeKey: `budget.overrun_decided:${row.id}:${outcome}:${ctx.now.toISOString()}`,
  subjectType: 'BUDGET_OVERRUN',
  subjectId: row.id,
})

/** The last step approved: X enters the line and is earmarked for the request (BR-BUD-13) until lapsesAt */
export async function approveOverrun(tx: TenantTx, ctx: Ctx, overrunId: string): Promise<Decided> {
  const row = await lockedOverrun(tx, ctx, overrunId)
  if (!row) return fail('NOT_FOUND', 'over-budget approval not found')
  const moved = move(row.status, 'budgetOverrun.final_approval')
  if (!moved.ok) return moved
  const applied = await applyBudget(tx, ctx, [{ budgetLineId: row.budgetLineId, document: { type: 'BUDGET_OVERRUN', id: row.id }, run: (s) => earmarkOverrun(s, row.id, row.shortfallSatang) }])
  if (!applied.ok) return applied
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const lapsesAt = new Date(ctx.now.getTime() + s6SettingsOf(org.settings).overrunLapseDays * MS_PER_DAY)
  await tx.budgetOverrun.update({ where: { id: row.id }, data: { status: moved.to, approvedAt: ctx.now, lapsesAt, version: { increment: 1 } } })
  return {
    ok: true,
    events: [
      { type: 'budget_overrun.approved', aggregateType: 'BudgetOverrun', aggregateId: row.id, data: { requestId: row.requestId, budgetLineId: row.budgetLineId, number: row.number, shortfallSatang: row.shortfallSatang.toString(), lapsesAt: lapsesAt.toISOString() } },
      ...applied.events,
    ],
    notifications: [decidedNotice(row, 'APPROVED', ctx, lapsesAt.toISOString().slice(0, 10))],
  }
}

/** A step rejected or returned: nothing had moved; the requester hears why and may ask again */
export async function declineOverrun(tx: TenantTx, ctx: Ctx, overrunId: string, outcome: 'REJECTED' | 'RETURNED', reasonCommentId: string | null): Promise<Decided> {
  const row = await lockedOverrun(tx, ctx, overrunId)
  if (!row) return fail('NOT_FOUND', 'over-budget approval not found')
  const command = outcome === 'REJECTED' ? 'approval.reject' : 'approval.return'
  const moved = move(row.status, command)
  if (!moved.ok) return moved
  await tx.budgetOverrun.update({ where: { id: row.id }, data: { status: moved.to, version: { increment: 1 } } })
  return {
    ok: true,
    events: [{ type: outcome === 'REJECTED' ? 'budget_overrun.rejected' : 'budget_overrun.returned', aggregateType: 'BudgetOverrun', aggregateId: row.id, data: { number: row.number, reasonCommentId } }],
    notifications: [decidedNotice(row, outcome, ctx)],
  }
}

// ---------- job budget-overrun-lapse ----------

export const lapseOverrunsCommand = defineCommand({
  name: 'budgetOverrun.lapse_due',
  capability: 'budget.overrun.submit',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ lapsed: number; reminded: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'only the scheduled job lapses over-budget approvals')
    const soon = new Date(ctx.now.getTime() + OVERRUN_LAPSING_NOTICE_DAYS * MS_PER_DAY)
    const due = await tx.budgetOverrun.findMany({ where: { status: 'APPROVED', lapsesAt: { lte: soon } }, select: { id: true }, orderBy: { id: 'asc' } })
    if (due.length === 0) return fail('NOT_FOUND', 'no over-budget approval lapses soon')
    const reminded = new Set((await tx.event.findMany({ where: { type: 'budget_overrun.lapse_reminded', aggregateId: { in: due.map((o) => o.id) } }, select: { aggregateId: true } })).map((e) => e.aggregateId))
    const events: EventDraft[] = []
    const notifications: NotificationDraft[] = []
    let lapsed = 0
    for (const { id } of due) {
      const row = await lockedOverrun(tx, ctx, id)
      if (!row || row.status !== 'APPROVED' || !row.lapsesAt) continue
      if (row.lapsesAt <= ctx.now) {
        const r = await lapse(tx, ctx, row, 'budgetOverrun.lapse', 'EXPIRED')
        if (!r.ok) return r
        events.push(...r.events)
        lapsed++
        continue
      }
      // Once, two days before
      if (reminded.has(row.id)) continue
      events.push({ type: 'budget_overrun.lapse_reminded', aggregateType: 'BudgetOverrun', aggregateId: row.id, data: { number: row.number, lapsesAt: row.lapsesAt.toISOString() } })
      notifications.push({
        recipientMemberId: row.submittedById,
        templateKey: 'budget.overrun_lapsing',
        data: { overrunId: row.id, number: row.number, requestId: row.requestId, lapsesOn: row.lapsesAt.toISOString().slice(0, 10) },
        urgency: 'IMMEDIATE',
        dedupeKey: `budget.overrun_lapsing:${row.id}`,
        subjectType: 'BUDGET_OVERRUN',
        subjectId: row.id,
      })
    }
    if (events.length === 0) return fail('NOT_FOUND', 'every over-budget approval lapsing soon was reminded already')
    return { ok: true, result: { lapsed, reminded: notifications.length }, events, notifications }
  },
})

/** What the job budget-overrun-lapse runs for one organization in one hour; the hour is the idempotency key */
export function runOverrunLapse(organizationId: string, now: Date) {
  return runCommand(systemCtx(organizationId, now, 'budget-overrun-lapse'), lapseOverrunsCommand, {}, { idempotencyKey: `budget-overrun-lapse:${now.toISOString().slice(0, 13)}` })
}
