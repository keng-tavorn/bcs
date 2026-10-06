import { allocationKey, type BudgetError, type BudgetResult, type Buckets, type LineState, type Movement, type SourceType } from '@/core/budget'
import { satangToAmount } from '@/core/money/dto'
import type { AppError } from '@/core/result'
import { newId } from '@/lib/ids'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// Running the ledger engine on stored budget lines (spec §7.7, S3-03), inside the calling command's transaction. The
// balance row of the line is locked FOR UPDATE first (INV-BUD-05, ids in ascending order across lines, INV-PLT-03), the
// engine works on the locked state, and the movements are written as ledger rows next to the new balance and the
// allocations of the document lines (BR-BUD-01: never one without the other). Each kind of movement of an operation
// is one event (an approved PO line gives back reservations and then holds: two events), whose id is made here and
// named by its ledger rows (INV-BUD-04). A refusal writes nothing.

export type BudgetEventType = 'budget.imported' | 'budget.reserved' | 'budget.reservation_released' | 'budget.committed' | 'budget.commitment_released' | 'budget.actualized'

/** §7.7: the event of each movement between buckets */
const EVENT_OF_MOVEMENT: Readonly<Record<string, BudgetEventType>> = {
  'OUTSIDE>AVAILABLE': 'budget.imported',
  'AVAILABLE>RESERVED': 'budget.reserved',
  'RESERVED>AVAILABLE': 'budget.reservation_released',
  'AVAILABLE>COMMITTED': 'budget.committed',
  'COMMITTED>AVAILABLE': 'budget.commitment_released',
  'COMMITTED>ACTUAL': 'budget.actualized',
}

function eventOf(m: Movement): BudgetEventType {
  const type = EVENT_OF_MOVEMENT[`${m.from}>${m.to}`]
  if (!type) throw new Error(`no budget event for a movement ${m.from} → ${m.to}`)
  return type
}

export interface BudgetOperation {
  readonly budgetLineId: string
  /** The document whose action moves the money (event data) */
  readonly document: { readonly type: 'IMPORT' | 'REQUEST' | 'PURCHASE_ORDER'; readonly id: string }
  readonly run: (state: LineState) => BudgetResult
}

/** The engine's refusal as the error the service returns (§14.2: amounts as baht text) */
export function budgetDomainError(error: BudgetError): AppError {
  switch (error.code) {
    case 'BUDGET_INSUFFICIENT':
      return { code: 'BUDGET_INSUFFICIENT', message: 'not enough budget left', details: { available: satangToAmount(error.available), shortfall: satangToAmount(error.shortfall) } }
    case 'BUDGET_LINE_CLOSED':
      return { code: 'BUDGET_LINE_CLOSED', message: 'the budget line takes no new reservation', details: { status: error.status } }
    case 'INVOICE_EXCEEDS_COMMITTED':
      return { code: 'INVOICE_EXCEEDS_COMMITTED', message: 'the invoice is above what the PO still holds', details: { remaining: satangToAmount(error.remaining) } }
    case 'VALIDATION_FAILED':
      return { code: 'VALIDATION_FAILED', message: 'the budget operation does not fit the budget line', details: { reason: error.reason } }
  }
}

/** The state of budget lines, locked in ascending id order; a line that does not exist is missing from the map */
export async function lockBudgetLines(tx: TenantTx, ctx: Ctx, budgetLineIds: readonly string[]): Promise<Map<string, LineState>> {
  const locked = await lockRowsForUpdate(tx, 'BudgetLineBalance', ctx.organizationId, budgetLineIds)
  const states = new Map<string, LineState>()
  if (locked.length === 0) return states
  const [lines, balances, allocations] = await Promise.all([
    tx.budgetLine.findMany({ where: { id: { in: locked } }, select: { id: true, status: true, plannedSatang: true } }),
    tx.budgetLineBalance.findMany({ where: { budgetLineId: { in: locked } } }),
    tx.budgetAllocation.findMany({ where: { budgetLineId: { in: locked } } }),
  ])
  for (const line of lines) {
    const b = balances.find((x) => x.budgetLineId === line.id)!
    const own = allocations.filter((a) => a.budgetLineId === line.id)
    states.set(line.id, {
      status: line.status,
      funded: line.plannedSatang,
      buckets: { available: b.availableSatang, reserved: b.reservedSatang, committed: b.committedSatang, actual: b.actualSatang },
      allocations: Object.fromEntries(own.map((a) => [allocationKey(a.sourceType, a.sourceId), { reserved: a.reservedSatang, committed: a.committedSatang, actual: a.actualSatang }])),
    })
  }
  return states
}

/**
 * Runs operations on locked lines in order and writes what they moved. All lines are locked before the first
 * operation runs. The first refusal stops everything and is returned; the caller's command then writes nothing.
 */
export async function applyBudget(
  tx: TenantTx,
  ctx: Ctx,
  operations: readonly BudgetOperation[],
): Promise<{ ok: true; events: EventDraft[]; lines: Array<{ budgetLineId: string; before: Buckets; after: Buckets }> } | { ok: false; error: AppError }> {
  const states = await lockBudgetLines(tx, ctx, operations.map((o) => o.budgetLineId))
  const planned: Array<{ op: BudgetOperation; before: LineState; after: LineState; movements: readonly Movement[] }> = []
  for (const op of operations) {
    const before = states.get(op.budgetLineId)
    if (!before) return { ok: false, error: { code: 'NOT_FOUND', message: 'budget line not found', details: { budgetLineId: op.budgetLineId } } }
    const result = op.run(before)
    if (!result.ok) return { ok: false, error: budgetDomainError(result.error) }
    planned.push({ op, before, after: result.state, movements: result.movements })
    states.set(op.budgetLineId, result.state)
  }

  const events: EventDraft[] = []
  for (const { op, before, after, movements } of planned) {
    if (movements.length === 0) continue
    const balance = await tx.budgetLineBalance.findUniqueOrThrow({ where: { budgetLineId: op.budgetLineId }, select: { lastSeq: true } })
    // Consecutive movements of one kind make one event; every ledger row names its event
    const groups: Array<{ type: BudgetEventType; id: string; seqFrom: number; movements: Movement[] }> = []
    movements.forEach((m, i) => {
      const type = eventOf(m)
      const last = groups.at(-1)
      if (last && last.type === type) last.movements.push(m)
      else groups.push({ type, id: newId(), seqFrom: balance.lastSeq + 1 + i, movements: [m] })
    })
    await tx.budgetLedgerEntry.createMany({
      data: groups.flatMap((g) =>
        g.movements.map((m, i) => ({
          organizationId: ctx.organizationId,
          budgetLineId: op.budgetLineId,
          seq: g.seqFrom + i,
          fromBucket: m.from,
          toBucket: m.to,
          amountSatang: m.amount,
          sourceType: m.sourceType,
          sourceId: m.sourceId,
          eventId: g.id,
        })),
      ),
    })
    const seqTo = balance.lastSeq + movements.length
    await tx.budgetLineBalance.update({
      where: { budgetLineId: op.budgetLineId },
      data: {
        availableSatang: after.buckets.available,
        reservedSatang: after.buckets.reserved,
        committedSatang: after.buckets.committed,
        actualSatang: after.buckets.actual,
        lastSeq: seqTo,
        version: { increment: 1 },
      },
    })
    if (after.funded !== before.funded) await tx.budgetLine.update({ where: { id: op.budgetLineId }, data: { plannedSatang: after.funded, version: { increment: 1 } } })
    // The document lines whose holdings changed
    const touched = new Set(movements.filter((m) => m.sourceType !== 'IMPORT').map((m) => allocationKey(m.sourceType, m.sourceId)))
    for (const key of touched) {
      const [sourceType, sourceId] = key.split(':') as [Exclude<SourceType, 'IMPORT'>, string]
      const a = after.allocations[key]!
      await tx.budgetAllocation.upsert({
        where: { organizationId_budgetLineId_sourceType_sourceId: { organizationId: ctx.organizationId, budgetLineId: op.budgetLineId, sourceType, sourceId } },
        create: { organizationId: ctx.organizationId, budgetLineId: op.budgetLineId, sourceType, sourceId, reservedSatang: a.reserved, committedSatang: a.committed, actualSatang: a.actual },
        update: { reservedSatang: a.reserved, committedSatang: a.committed, actualSatang: a.actual, version: { increment: 1 } },
      })
    }
    for (const g of groups) {
      events.push({
        id: g.id,
        type: g.type,
        aggregateType: 'BudgetLine',
        aggregateId: op.budgetLineId,
        data: {
          documentType: op.document.type,
          documentId: op.document.id,
          amountSatang: g.movements.reduce((sum, m) => sum + m.amount, 0n).toString(),
          seqFrom: g.seqFrom,
          seqTo: g.seqFrom + g.movements.length - 1,
        },
      })
    }
  }
  return { ok: true, events, lines: planned.map((p) => ({ budgetLineId: p.op.budgetLineId, before: p.before.buckets, after: p.after.buckets })) }
}
