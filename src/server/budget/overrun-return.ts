import { allocationKey, netReturned, returnAfterUse, type LineState, type Movement } from '@/core/budget'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// BR-BUD-18 (S6-16 · ADR-105): after an overrun was used, every command that gives back what its request holds on the
// line — the request's lines, and the PO lines ordered from them — takes the unused part of what was funded for the
// request out of the line, in the same transaction: s = min(outstanding, what the command gave back net) moves
// AVAILABLE → OUTSIDE under the overrun, to the overrun used last first. What other documents give back, imports and
// transfers in never do. applyBudget calls it with the movements of one command on lines it has locked, so the overruns
// read here change only under those locks.

export interface ReturnAfterUse {
  readonly budgetLineId: string
  readonly overrunId: string
  readonly before: LineState
  readonly after: LineState
  readonly movements: readonly Movement[]
}

const GIVES_BACK = (m: Movement) => (m.sourceType === 'REQUEST_LINE' || m.sourceType === 'PO_LINE') && m.to === 'AVAILABLE' && (m.from === 'RESERVED' || m.from === 'COMMITTED')

/**
 * The returns after use of one command: `movements` per line in the order they ran, `states` the lines after them.
 * Writes the overruns' returnedAfterUseSatang and returns the ledger work and the domain events.
 */
export async function returnsAfterUse(
  tx: TenantTx,
  movements: ReadonlyMap<string, readonly Movement[]>,
  states: Map<string, LineState>,
): Promise<{ returns: ReturnAfterUse[]; events: EventDraft[] }> {
  const lines = [...movements].filter(([, ms]) => ms.some(GIVES_BACK)).map(([id]) => id)
  if (lines.length === 0) return { returns: [], events: [] }
  const used = (
    await tx.budgetOverrun.findMany({
      where: { budgetLineId: { in: lines }, status: 'CONSUMED' },
      select: { id: true, number: true, requestId: true, budgetLineId: true, usedSatang: true, returnedAfterUseSatang: true, consumedAt: true },
      // The overrun used last first (BR-BUD-18)
      orderBy: [{ consumedAt: 'desc' }, { number: 'desc' }],
    })
  ).filter((o) => o.usedSatang > o.returnedAfterUseSatang)
  if (used.length === 0) return { returns: [], events: [] }

  const requestIds = [...new Set(used.map((o) => o.requestId))]
  const requestLines = await tx.requestLine.findMany({ where: { requestId: { in: requestIds } }, select: { id: true, requestId: true } })
  const poSources = await tx.poLineSource.findMany({ where: { requestLineId: { in: requestLines.map((l) => l.id) } }, select: { poLineId: true, requestLineId: true } })
  const requestOf = new Map(requestLines.map((l) => [l.id, l.requestId]))
  /** Per request: the allocations that are its own — its lines and the PO lines ordered from them */
  const keysOf = new Map<string, Set<string>>()
  for (const l of requestLines) keysOf.set(l.requestId, (keysOf.get(l.requestId) ?? new Set()).add(allocationKey('REQUEST_LINE', l.id)))
  for (const s of poSources) keysOf.get(requestOf.get(s.requestLineId)!)!.add(allocationKey('PO_LINE', s.poLineId))

  const returns: ReturnAfterUse[] = []
  const events: EventDraft[] = []
  for (const budgetLineId of lines) {
    for (const requestId of requestIds) {
      const overruns = used.filter((o) => o.budgetLineId === budgetLineId && o.requestId === requestId)
      if (overruns.length === 0) continue
      const given = netReturned(movements.get(budgetLineId)!, keysOf.get(requestId)!)
      const r = returnAfterUse(
        states.get(budgetLineId)!,
        given,
        overruns.map((o) => ({ id: o.id, outstanding: o.usedSatang - o.returnedAfterUseSatang })),
      )
      let state = states.get(budgetLineId)!
      for (const m of r.movements) {
        const o = overruns.find((x) => x.id === m.sourceId)!
        const after = returnAfterUse(state, m.amount, [{ id: o.id, outstanding: m.amount }]).state
        returns.push({ budgetLineId, overrunId: o.id, before: state, after, movements: [m] })
        state = after
        const total = o.returnedAfterUseSatang + m.amount
        await tx.budgetOverrun.update({ where: { id: o.id }, data: { returnedAfterUseSatang: total, version: { increment: 1 } } })
        events.push({
          type: 'budget_overrun.unused_returned',
          aggregateType: 'BudgetOverrun',
          aggregateId: o.id,
          data: { requestId, budgetLineId, number: o.number, amountSatang: m.amount.toString(), returnedAfterUseSatang: total.toString() },
        })
      }
      states.set(budgetLineId, r.state)
    }
  }
  return { returns, events }
}
