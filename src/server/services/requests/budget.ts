import { release, reserve } from '@/core/budget'
import type { AppError } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { applyBudget, type BudgetOperation } from '@/server/budget/ledger'
import type { EventDraft } from '@/server/events/append'

// The budget side of a purchase request (spec §6.4, BR-BUD-02 to BR-BUD-04, FR-INT-007 AC1, FR-BUD-003): at submit the
// request's budget line is checked and its lines reserved, all within the submit transaction — a request over budget
// never reaches an approver; a return keeps the reservation; a resubmit gives back what the lines held and reserves
// again (the difference is what moves); a rejection or a cancellation gives everything back.

type Fail = { ok: false; error: AppError }
const fail = (code: AppError['code'], message: string, details: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, details } })

/**
 * The budget line a request reserves on (BR-BUD-04): the one given, or — when none is given — the only open line of
 * the requester's department in the fiscal year of the tax date (the form fills it the same way, BR-FORM-02). The
 * requester uses their own department's lines, or another's through a BudgetGrant in force.
 */
export async function resolveBudgetLine(
  tx: TenantTx,
  ctx: Ctx,
  request: { readonly requesterMemberId: string; readonly budgetLineId: string | null },
  taxDate: string,
): Promise<{ ok: true; line: { id: string; departmentId: string } } | Fail> {
  const requester = await tx.member.findUniqueOrThrow({ where: { id: request.requesterMemberId }, select: { primaryDepartmentId: true } })
  const day = new Date(`${taxDate}T00:00:00Z`)
  const inYear = { fiscalYear: { startsOn: { lte: day }, endsOn: { gte: day } } }
  let lineId = request.budgetLineId
  if (!lineId) {
    const own = await tx.budgetLine.findMany({ where: { departmentId: requester.primaryDepartmentId ?? undefined, status: 'OPEN', ...inYear }, select: { id: true }, take: 2 })
    if (own.length !== 1) return fail('VALIDATION_FAILED', 'choose the budget line the request uses', { field: 'budgetLineId', reason: own.length ? 'CHOOSE_BUDGET_LINE' : 'NO_BUDGET_LINE' })
    lineId = own[0]!.id
  }
  const line = await tx.budgetLine.findFirst({ where: { id: lineId }, select: { id: true, departmentId: true, fiscalYear: { select: { startsOn: true, endsOn: true } } } })
  if (!line) return fail('VALIDATION_FAILED', 'unknown budget line', { field: 'budgetLineId', reason: 'BUDGET_LINE' })
  if (line.fiscalYear.startsOn > day || line.fiscalYear.endsOn < day) return fail('VALIDATION_FAILED', 'the budget line is of another fiscal year', { field: 'budgetLineId', reason: 'BUDGET_LINE_YEAR' })
  if (line.departmentId !== requester.primaryDepartmentId) {
    const granted = await tx.budgetGrant.count({
      where: {
        budgetLineId: line.id,
        revokedAt: null,
        validFrom: { lte: ctx.now },
        AND: [{ OR: [{ validTo: null }, { validTo: { gt: ctx.now } }] }, { OR: [{ granteeMemberId: request.requesterMemberId }, ...(requester.primaryDepartmentId ? [{ granteeDepartmentId: requester.primaryDepartmentId }] : [])] }],
      },
    })
    if (granted === 0) return fail('FORBIDDEN', 'the budget line belongs to another department', { field: 'budgetLineId', reason: 'BUDGET_LINE_NOT_ALLOWED' })
  }
  return { ok: true, line: { id: line.id, departmentId: line.departmentId } }
}

/** Operations that give back what these request lines hold, on whichever budget line holds it */
async function releaseOperations(tx: TenantTx, requestId: string, requestLineIds: readonly string[]): Promise<BudgetOperation[]> {
  if (requestLineIds.length === 0) return []
  const held = await tx.budgetAllocation.findMany({ where: { sourceType: 'REQUEST_LINE', sourceId: { in: [...requestLineIds] }, reservedSatang: { gt: 0n } }, select: { budgetLineId: true, sourceId: true } })
  const byLine = new Map<string, string[]>()
  for (const h of held) byLine.set(h.budgetLineId, [...(byLine.get(h.budgetLineId) ?? []), h.sourceId])
  return [...byLine].map(([budgetLineId, ids]) => ({ budgetLineId, document: { type: 'REQUEST' as const, id: requestId }, run: (s) => release(s, ids) }))
}

export interface BudgetCheck {
  readonly budgetLineId: string
  /** What the line had available when the request was checked (after giving back its earlier reservation) */
  readonly availableSatang: string
  readonly reservedSatang: string
}

/**
 * Reserves the request's lines on the budget line (BR-BUD-02): first what the lines held before is given back (a
 * resubmit, or another budget line chosen), then all lines are reserved against their total, or nothing happens.
 */
export async function reserveForRequest(
  tx: TenantTx,
  ctx: Ctx,
  requestId: string,
  budgetLineId: string,
  lines: ReadonlyArray<{ readonly requestLineId: string; readonly netSatang: bigint }>,
): Promise<{ ok: true; events: EventDraft[]; check: BudgetCheck } | Fail> {
  const releases = await releaseOperations(tx, requestId, lines.map((l) => l.requestLineId))
  const reserving = lines.filter((l) => l.netSatang > 0n)
  const result = await applyBudget(tx, ctx, [
    ...releases,
    { budgetLineId, document: { type: 'REQUEST', id: requestId }, run: (s) => reserve(s, reserving.map((l) => ({ requestLineId: l.requestLineId, amount: l.netSatang }))) },
  ])
  if (!result.ok) return result
  const total = reserving.reduce((sum, l) => sum + l.netSatang, 0n)
  // What the reservation was checked against: the line's available amount after it gave back what the request held
  const checkedAgainst = result.lines.filter((l) => l.budgetLineId === budgetLineId).at(-1)!.before.available
  return { ok: true, events: result.events, check: { budgetLineId, availableSatang: checkedAgainst.toString(), reservedSatang: total.toString() } }
}

/** Gives back everything the request's lines hold (rejection or cancellation) */
export async function releaseForRequest(tx: TenantTx, ctx: Ctx, requestId: string, requestLineIds: readonly string[]): Promise<{ ok: true; events: EventDraft[] } | Fail> {
  const operations = await releaseOperations(tx, requestId, requestLineIds)
  if (operations.length === 0) return { ok: true, events: [] }
  const result = await applyBudget(tx, ctx, operations)
  return result.ok ? { ok: true, events: result.events } : result
}
