import { allocationKey, approvePo, cancelPo, closePo, rejectPo, submitPo, type LineState, type PoLine as EnginePoLine } from '@/core/budget'
import type { Satang } from '@/core/money/math'
import type { AppError } from '@/core/result'
import { isAllowed, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import type { TenantTx } from '@/server/db/tenant'
import { applyBudget, type BudgetOperation } from '@/server/budget/ledger'
import type { EventDraft } from '@/server/events/append'

// The budget side of a PO (spec §7.7, BR-BUD-05, BR-BUD-06, GC-BUD-01 to GC-BUD-05), inside the calling command's
// transaction. Each PO line needs its amount before VAT on the budget line of its request; its source request lines
// give back their releasable when the PO is approved:
//  · submit   — delta = need − Σ releasable is reserved for the PO line when above zero (else nothing moves)
//  · approve  — the sources give back their releasable (never more than the request line still reserves, so a line
//               ordered in parts cannot give back a satang too many) and the delta, then the PO line holds its need
//  · reject / return — the delta goes back
//  · cancel   — what the PO line holds goes back; RETURN_TO_POOL reserves the releasable again for the request lines
//  · close    — what the PO line holds goes back, except what was received and not yet invoiced (ADR-038 ข้อ 10)

type Fail = { ok: false; error: AppError }
export type PoBudgetResult = { ok: true; events: EventDraft[] } | Fail

export interface PoBudgetLine {
  readonly poLineId: string
  readonly budgetLineId: string
  /** The PO line's amount before VAT (BR-BUD-03) */
  readonly need: Satang
  readonly sources: readonly { readonly requestLineId: string; readonly releasable: Satang }[]
}

/**
 * A refusal for lack of budget as the actor may read it. What is left on a budget line and how much is missing are
 * budget figures (§2.4 budget.view: the head of the line's department or an organization-wide budget role); PROCUREMENT
 * sends and cancels POs without that right, so its refusal says only that the budget is short — the same rule the
 * receiving service applies to a receipt (services/receiving seesBudgetOf). Any other error passes unchanged.
 */
export async function budgetRefusalFor(tx: TenantTx, principal: Principal, error: AppError, budgetLineIds: readonly string[]): Promise<AppError> {
  if (error.code !== 'BUDGET_INSUFFICIENT') return error
  const lines = await tx.budgetLine.findMany({ where: { id: { in: [...new Set(budgetLineIds)] } }, select: { departmentId: true } })
  const sees = lines.length > 0 && lines.every((l) => isAllowed(principal, 'budget.view', { departmentId: l.departmentId }))
  return sees ? error : { code: error.code, message: error.message }
}

/** The PO's lines as the budget engine sees them */
export async function poBudgetLines(tx: TenantTx, poId: string): Promise<PoBudgetLine[]> {
  const lines = await tx.poLine.findMany({ where: { poId }, orderBy: { lineNo: 'asc' }, select: { id: true, budgetLineId: true, netSatang: true, sources: { orderBy: { id: 'asc' }, select: { requestLineId: true, releasableSatang: true } } } })
  return lines.map((l) => ({ poLineId: l.id, budgetLineId: l.budgetLineId, need: l.netSatang, sources: l.sources.map((s) => ({ requestLineId: s.requestLineId, releasable: s.releasableSatang })) }))
}

const engineLine = (l: PoBudgetLine): EnginePoLine => ({ poLineId: l.poLineId, need: l.need, sources: l.sources })

async function run(tx: TenantTx, ctx: Ctx, poId: string, lines: readonly PoBudgetLine[], step: (state: LineState, line: PoBudgetLine) => ReturnType<BudgetOperation['run']>): Promise<PoBudgetResult> {
  const operations: BudgetOperation[] = lines.map((line) => ({ budgetLineId: line.budgetLineId, document: { type: 'PURCHASE_ORDER', id: poId }, run: (s) => step(s, line) }))
  if (operations.length === 0) return { ok: true, events: [] }
  const result = await applyBudget(tx, ctx, operations)
  return result.ok ? { ok: true, events: result.events } : result
}

/** BR-BUD-05 at submit: reserve the delta of every line, or nothing at all (BUDGET_INSUFFICIENT) */
export function reserveForPo(tx: TenantTx, ctx: Ctx, poId: string, lines: readonly PoBudgetLine[]): Promise<PoBudgetResult> {
  return run(tx, ctx, poId, lines, (s, line) => submitPo(s, engineLine(line)))
}

/** What a request line still reserves on the state of its budget line */
const stillReserved = (state: LineState, requestLineId: string) => state.allocations[allocationKey('REQUEST_LINE', requestLineId)]?.reserved ?? 0n

/** BR-BUD-05 at approval: the sources give back (capped by what they still reserve), then the line holds its need */
export function commitForPo(tx: TenantTx, ctx: Ctx, poId: string, lines: readonly PoBudgetLine[]): Promise<PoBudgetResult> {
  return run(tx, ctx, poId, lines, (s, line) => {
    const left = new Map<string, Satang>()
    const sources = line.sources.map((src) => {
      const reserved = left.get(src.requestLineId) ?? stillReserved(s, src.requestLineId)
      const releasable = src.releasable < reserved ? src.releasable : reserved
      left.set(src.requestLineId, reserved - releasable)
      return { requestLineId: src.requestLineId, releasable }
    })
    return approvePo(s, { ...engineLine(line), sources })
  })
}

/** A PO rejected or returned gives back the delta it reserved (GC-BUD-03) */
export function releasePoDelta(tx: TenantTx, ctx: Ctx, poId: string, lines: readonly PoBudgetLine[]): Promise<PoBudgetResult> {
  return run(tx, ctx, poId, lines, (s, line) => rejectPo(s, line.poLineId))
}

/** BR-BUD-06: an approved PO cancelled gives back what it holds; RETURN_TO_POOL reserves the request lines again (GC-BUD-04) */
export function releaseCancelledPo(tx: TenantTx, ctx: Ctx, poId: string, lines: readonly PoBudgetLine[], disposition: 'RETURN_TO_POOL' | 'CANCEL_REQUEST_LINES'): Promise<PoBudgetResult> {
  return run(tx, ctx, poId, lines, (s, line) => cancelPo(s, engineLine(line), disposition))
}

/** BR-BUD-06: closing gives back what each line holds except `keep` (received, not yet invoiced) */
export function releaseClosedPo(tx: TenantTx, ctx: Ctx, poId: string, lines: readonly PoBudgetLine[], keep: ReadonlyMap<string, Satang>): Promise<PoBudgetResult> {
  return run(tx, ctx, poId, lines, (s, line) => closePo(s, line.poLineId, keep.get(line.poLineId) ?? 0n))
}
