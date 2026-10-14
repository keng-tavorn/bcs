import { consumeOverrun, lapseOverrun, type OverrunResult } from '@/core/budget'
import type { AppError } from '@/core/result'
import { transition, BUDGET_OVERRUN_MACHINE, type BudgetOverrunCommand, type BudgetOverrunState } from '@/core/state-machines'
import { applyBudget, type BudgetOperation } from '@/server/budget/ledger'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { closeRoute } from '../approvals/route'

// What a request does to its over-budget approvals (S6-16 · BR-BUD-14, BR-BUD-15 · ADR-105), inside the request's own
// command: its submit or resubmit uses the approved overrun of the line it reserves on (and lets an approved one of
// another line lapse), and is refused while one still waits for approval; its cancellation cancels one waiting and lets
// an approved one lapse. The commands of the overrun itself are in ./overruns.ts.

type Fail = { ok: false; error: AppError }

const SELECT = { id: true, number: true, requestId: true, budgetLineId: true, shortfallSatang: true, status: true, lapsesAt: true } as const
export type OverrunRow = { id: string; number: string; requestId: string; budgetLineId: string; shortfallSatang: bigint; status: string; lapsesAt?: Date | null }

/** The live overruns of a request (PENDING_APPROVAL or APPROVED), locked in id order */
export async function liveOverruns(tx: TenantTx, ctx: Ctx, requestId: string): Promise<OverrunRow[]> {
  const live = await tx.budgetOverrun.findMany({ where: { requestId, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, select: { id: true } })
  if (live.length === 0) return []
  const locked = await lockRowsForUpdate(tx, 'BudgetOverrun', ctx.organizationId, live.map((o) => o.id))
  return tx.budgetOverrun.findMany({ where: { id: { in: locked }, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } }, select: SELECT, orderBy: { id: 'asc' } })
}

const moved = (row: OverrunRow, command: BudgetOverrunCommand) => {
  const t = transition(BUDGET_OVERRUN_MACHINE, row.status as BudgetOverrunState, command)
  if (!t.ok) throw new Error(`${command} is not allowed from ${row.status}`)
  return t.to
}

/** The refusal of a request whose overrun still waits for approval: its amount and budget line are locked (§6.4) */
export const overrunPending = (): Fail => ({
  ok: false,
  error: { code: 'INVALID_STATE_TRANSITION', message: 'the over-budget approval of the request is still waiting', details: { reason: 'OVERRUN_PENDING' } },
})

export interface OverrunUse {
  /**
   * Per budget line of the submit, the operation that reserves its lines when an approved overrun of that line is used
   * (BR-BUD-14); a line without one is reserved as usual by the caller
   */
  readonly reserve: ReadonlyMap<string, BudgetOperation>
  /** Approved overruns of lines the submit does not use or past their lapsesAt, which it lets lapse (BR-BUD-15) */
  readonly lapse: BudgetOperation[]
  /** After applyBudget succeeded: the overruns' new state and their events, and each used line's earmark */
  readonly settle: () => Promise<{ events: EventDraft[]; overrunIds: string[]; earmarks: ReadonlyMap<string, bigint> }>
}

/**
 * The overrun side of a submit or resubmit reserving its lines on one or more budget lines (S6-17): refused while an
 * overrun waits for approval; on a line with an approved overrun, the reservation uses it (needed of X, the rest leaves
 * the line)
 */
export async function overrunsForReserve(
  tx: TenantTx,
  ctx: Ctx,
  requestId: string,
  groups: ReadonlyArray<{ readonly budgetLineId: string; readonly lines: ReadonlyArray<{ readonly requestLineId: string; readonly amount: bigint }> }>,
): Promise<OverrunUse | Fail> {
  const live = await liveOverruns(tx, ctx, requestId)
  if (live.some((o) => o.status === 'PENDING_APPROVAL')) return overrunPending()
  // Past its lapsesAt an approved overrun is never used, even before the job budget-overrun-lapse lets it lapse
  const usable = (o: OverrunRow) => (!o.lapsesAt || o.lapsesAt > ctx.now) && groups.some((g) => g.budgetLineId === o.budgetLineId)
  const own = live.filter(usable)
  const others = live.filter((o) => !usable(o))
  const used = new Map<string, Extract<OverrunResult, { ok: true }>>()
  const lapsed = new Map<string, bigint>()
  const reserve = new Map<string, BudgetOperation>()
  for (const o of own) {
    const lines = groups.find((g) => g.budgetLineId === o.budgetLineId)!.lines
    reserve.set(o.budgetLineId, {
      budgetLineId: o.budgetLineId,
      document: { type: 'REQUEST', id: requestId },
      run: (s) => {
        const r = consumeOverrun(s, o.id, lines.map((l) => ({ requestLineId: l.requestLineId, amount: l.amount })))
        if (r.ok) used.set(o.id, r)
        return r
      },
    })
  }
  const lapse = others.map(
    (o): BudgetOperation => ({
      budgetLineId: o.budgetLineId,
      document: { type: 'BUDGET_OVERRUN', id: o.id },
      run: (s) => {
        const r = lapseOverrun(s, o.id)
        lapsed.set(o.id, r.returned)
        return r
      },
    }),
  )
  return {
    reserve,
    lapse,
    async settle() {
      const events: EventDraft[] = []
      const earmarks = new Map<string, bigint>()
      for (const o of own) {
        const u = used.get(o.id)!
        await tx.budgetOverrun.update({ where: { id: o.id }, data: { status: moved(o, 'budgetOverrun.consume'), usedSatang: u.used, returnedSatang: u.returned, consumedAt: ctx.now, version: { increment: 1 } } })
        events.push({ type: 'budget_overrun.consumed', aggregateType: 'BudgetOverrun', aggregateId: o.id, data: { requestId, budgetLineId: o.budgetLineId, number: o.number, usedSatang: u.used.toString(), returnedSatang: u.returned.toString() } })
        earmarks.set(o.budgetLineId, o.shortfallSatang)
      }
      for (const o of others) events.push(...(await markLapsed(tx, ctx, o, lapsed.get(o.id) ?? 0n, 'budgetOverrun.lapse', 'NOT_USED')))
      return { events, overrunIds: own.map((o) => o.id), earmarks }
    },
  }
}

/** Writes an overrun LAPSED after its earmark went back (lapseOverrun ran in the caller's applyBudget) */
async function markLapsed(tx: TenantTx, ctx: Ctx, row: OverrunRow, returned: bigint, command: BudgetOverrunCommand, by: 'REQUESTER' | 'REQUEST_CANCELLED' | 'EXPIRED' | 'NOT_USED'): Promise<EventDraft[]> {
  await tx.budgetOverrun.update({ where: { id: row.id }, data: { status: moved(row, command), usedSatang: 0n, returnedSatang: returned, version: { increment: 1 } } })
  return [{ type: 'budget_overrun.lapsed', aggregateType: 'BudgetOverrun', aggregateId: row.id, data: { requestId: row.requestId, budgetLineId: row.budgetLineId, number: row.number, returnedSatang: returned.toString(), by } }]
}

/**
 * BR-BUD-15: an approved overrun not used goes back — its earmark returns and X leaves the line — in the caller's
 * transaction (the requester cancels it, its request is cancelled, or it is past lapsesAt)
 */
export async function lapse(
  tx: TenantTx,
  ctx: Ctx,
  row: OverrunRow,
  command: 'budgetOverrun.cancel' | 'request.cancel' | 'budgetOverrun.lapse',
  by: 'REQUESTER' | 'REQUEST_CANCELLED' | 'EXPIRED',
): Promise<{ ok: true; events: EventDraft[] } | Fail> {
  let returned = 0n
  const applied = await applyBudget(tx, ctx, [
    {
      budgetLineId: row.budgetLineId,
      document: { type: 'BUDGET_OVERRUN', id: row.id },
      run: (s) => {
        const r = lapseOverrun(s, row.id)
        returned = r.returned
        return r
      },
    },
  ])
  if (!applied.ok) return applied
  return { ok: true, events: [...(await markLapsed(tx, ctx, row, returned, command, by)), ...applied.events] }
}

/** A request cancelled takes its live overruns with it: one waiting is cancelled with its route, one approved lapses */
export async function settleOverrunsOfCancelledRequest(tx: TenantTx, ctx: Ctx, requestId: string): Promise<{ ok: true; events: EventDraft[] } | Fail> {
  const events: EventDraft[] = []
  for (const o of await liveOverruns(tx, ctx, requestId)) {
    if (o.status === 'APPROVED') {
      const r = await lapse(tx, ctx, o, 'request.cancel', 'REQUEST_CANCELLED')
      if (!r.ok) return r
      events.push(...r.events)
      continue
    }
    events.push(...(await closeRoute(tx, { type: 'BUDGET_OVERRUN', id: o.id }, 'CANCELLED', 'REQUEST_CANCELLED')))
    await tx.budgetOverrun.update({ where: { id: o.id }, data: { status: moved(o, 'request.cancel'), version: { increment: 1 } } })
    events.push({ type: 'budget_overrun.cancelled', aggregateType: 'BudgetOverrun', aggregateId: o.id, data: { number: o.number, by: 'REQUEST_CANCELLED' } })
  }
  return { ok: true, events }
}

/**
 * BR-BUD-18: a PO line ordered from a request line whose request still has an overrun outstanding on the PO line's
 * budget line never merges other request lines with it, so what the request gives back stays its own. The index of the
 * first such PO line, or null.
 */
export async function unmergeableLine(
  tx: TenantTx,
  lines: ReadonlyArray<{ readonly budgetLineId: string | null; readonly sources: ReadonlyArray<{ readonly requestLineId: string }> }>,
): Promise<number | null> {
  const merged = lines.map((l, i) => ({ ...l, i })).filter((l) => l.sources.length > 1 && l.budgetLineId)
  if (merged.length === 0) return null
  const requestLines = await tx.requestLine.findMany({ where: { id: { in: merged.flatMap((l) => l.sources.map((s) => s.requestLineId)) } }, select: { id: true, requestId: true } })
  const requestOf = new Map(requestLines.map((l) => [l.id, l.requestId]))
  const outstanding = (
    await tx.budgetOverrun.findMany({ where: { status: 'CONSUMED', requestId: { in: [...new Set(requestLines.map((l) => l.requestId))] } }, select: { requestId: true, budgetLineId: true, usedSatang: true, returnedAfterUseSatang: true } })
  ).filter((o) => o.usedSatang > o.returnedAfterUseSatang)
  const hit = merged.find((l) => l.sources.some((s) => outstanding.some((o) => o.requestId === requestOf.get(s.requestLineId) && o.budgetLineId === l.budgetLineId)))
  return hit ? hit.i : null
}
