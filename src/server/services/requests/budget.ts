import { release, reserve } from '@/core/budget'
import type { AppError } from '@/core/result'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { applyBudget, type BudgetOperation } from '@/server/budget/ledger'
import type { EventDraft } from '@/server/events/append'
import { overrunsForReserve } from '../budget/overrun-use'

// The budget side of a purchase request (spec §6.4, BR-BUD-02 to BR-BUD-04, FR-INT-007 AC1, FR-BUD-003): at submit the
// request's budget line is checked and its lines reserved, all within the submit transaction — a request over budget
// never reaches an approver; a return keeps the reservation; a resubmit gives back what the lines held and reserves
// again (the difference is what moves); a rejection or a cancellation gives everything back. With an approved
// over-budget approval of its line, the reservation uses it (S6-16 · BR-BUD-14); one still waiting refuses the submit.

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

type BudgetLineRef = { id: string; departmentId: string }

/**
 * S6-17 (BR-BUD-16): the budget line of each request line — its own, or the request's (resolved as BR-BUD-04 says only
 * when a line uses it) — each one checked as the request's is: of the tax date's fiscal year, and the requester's own
 * department's or granted to them. A refusal names the line (`lines.N.budgetLineId`).
 */
export async function requestBudgetLines(
  tx: TenantTx,
  ctx: Ctx,
  request: { readonly requesterMemberId: string; readonly budgetLineId: string | null; readonly lines: ReadonlyArray<{ readonly budgetLineId: string | null }> },
  taxDate: string,
): Promise<{ ok: true; request: BudgetLineRef | null; byLine: BudgetLineRef[] } | Fail> {
  let own: BudgetLineRef | null = null
  if (request.lines.some((l) => !l.budgetLineId)) {
    const resolved = await resolveBudgetLine(tx, ctx, request, taxDate)
    if (!resolved.ok) return resolved
    own = resolved.line
  }
  const checked = new Map<string, BudgetLineRef>()
  const byLine: BudgetLineRef[] = []
  for (const [i, line] of request.lines.entries()) {
    if (!line.budgetLineId) {
      byLine.push(own!)
      continue
    }
    if (!checked.has(line.budgetLineId)) {
      const resolved = await resolveBudgetLine(tx, ctx, { requesterMemberId: request.requesterMemberId, budgetLineId: line.budgetLineId }, taxDate)
      if (!resolved.ok) return { ok: false, error: { ...resolved.error, details: { ...resolved.error.details, field: `lines.${i}.budgetLineId` } } }
      checked.set(line.budgetLineId, resolved.line)
    }
    byLine.push(checked.get(line.budgetLineId)!)
  }
  return { ok: true, request: own, byLine }
}

/** The budget line whose request lines add up to the most before VAT; on a tie, the one of the lowest line */
export function largestLine(groups: readonly ReserveGroup[], byLine: readonly BudgetLineRef[]): BudgetLineRef {
  const total = (g: ReserveGroup) => g.lines.reduce((sum, l) => sum + l.netSatang, 0n)
  const best = groups.reduce((a, b) => (total(b) > total(a) ? b : a))
  return byLine.find((l) => l.id === best.budgetLineId)!
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
  /**
   * What the line had available when the request was checked (after giving back its earlier reservation, and the
   * earmark of the overrun it uses: BR-BUD-14)
   */
  readonly availableSatang: string
  readonly reservedSatang: string
}

/** The request's lines on one budget line (S6-17 · BR-BUD-16: each line on its own, or the request's) */
export interface ReserveGroup {
  readonly budgetLineId: string
  readonly lines: ReadonlyArray<{ readonly requestLineId: string; readonly netSatang: bigint }>
}

/**
 * Reserves the request's lines on their budget lines (BR-BUD-02, BR-BUD-16): first what the lines held before is given
 * back (a resubmit, or another budget line chosen), then every budget line reserves its lines against their total — all
 * budget lines or none, locked in id order by applyBudget (INV-BUD-05). Returns one check per budget line, in the order
 * of the groups.
 */
export async function reserveForRequest(
  tx: TenantTx,
  ctx: Ctx,
  requestId: string,
  groups: readonly ReserveGroup[],
): Promise<{ ok: true; events: EventDraft[]; checks: BudgetCheck[]; overrunIds: string[] } | Fail> {
  const releases = await releaseOperations(tx, requestId, groups.flatMap((g) => g.lines.map((l) => l.requestLineId)))
  const reserving = groups.map((g) => ({ budgetLineId: g.budgetLineId, lines: g.lines.filter((l) => l.netSatang > 0n).map((l) => ({ requestLineId: l.requestLineId, amount: l.netSatang })) }))
  const overruns = await overrunsForReserve(tx, ctx, requestId, reserving)
  if ('ok' in overruns) return overruns
  // Lapses first (an overrun past its lapsesAt may be of a line reserved here), so each line's reservation runs last on it
  const result = await applyBudget(tx, ctx, [
    ...overruns.lapse,
    ...releases,
    ...reserving
      .filter((g) => g.lines.length > 0)
      .map((g) => overruns.reserve.get(g.budgetLineId) ?? { budgetLineId: g.budgetLineId, document: { type: 'REQUEST' as const, id: requestId }, run: (s: Parameters<typeof reserve>[0]) => reserve(s, g.lines) }),
  ])
  if (!result.ok) return result
  const settled = await overruns.settle()
  // What each reservation was checked against: the line's available amount after it gave back what the request held,
  // and the earmark of the overrun it used (BR-BUD-14)
  const checks = reserving.map((g) => {
    const last = result.lines.filter((l) => l.budgetLineId === g.budgetLineId).at(-1)
    const available = (last ? last.before.available : 0n) + (settled.earmarks.get(g.budgetLineId) ?? 0n)
    return { budgetLineId: g.budgetLineId, availableSatang: available.toString(), reservedSatang: g.lines.reduce((sum, l) => sum + l.amount, 0n).toString() }
  })
  return { ok: true, events: [...result.events, ...settled.events], checks, overrunIds: settled.overrunIds }
}

/** Gives back everything the request's lines hold (rejection or cancellation) */
export async function releaseForRequest(tx: TenantTx, ctx: Ctx, requestId: string, requestLineIds: readonly string[]): Promise<{ ok: true; events: EventDraft[] } | Fail> {
  const operations = await releaseOperations(tx, requestId, requestLineIds)
  if (operations.length === 0) return { ok: true, events: [] }
  const result = await applyBudget(tx, ctx, operations)
  return result.ok ? { ok: true, events: result.events } : result
}
