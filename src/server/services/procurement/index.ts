import { z } from 'zod'
import type { AppError } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { consolidateInTx } from './consolidate'
import { freeLines } from './pool'

export { consolidateInTx, consolidateNow, runScheduledConsolidation } from './consolidate'
export { countPoolLines, listPool, type PoolFilter, type PoolLineDto } from './pool-view'

// The procurement pool (spec FR-P2P-001): PROCUREMENT chooses the supplier of approved request lines, many at once
// (AC2), or takes the choice back. Only lines with something left to order can change: a line already on a draft PO
// changes on that PO (BR-CONS-04). Lines of an urgent request are drafted at once when they get their supplier
// (BR-CONS-02); the others wait for the round.

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND'
type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const AssignSupplierInput = z.strictObject({
  requestLineIds: z.array(z.uuid()).min(1).max(500),
  /** null takes the choice back */
  supplierId: z.uuid().nullable(),
})

/** The award a supplier is chosen by (S10-11 · ADR-206): its lines skip LINE_IN_RFX for their own RFx */
export interface AssignByAward {
  readonly awardDecisionId: string
  readonly rfxEventId: string
  /** The approver of the award, who acts for its submitter (ctx.actor) */
  readonly onBehalfOfMemberId: string | null
}

export interface SupplierAssigned {
  readonly ok: true
  /** The lines whose supplier changed, by request */
  readonly byRequest: ReadonlyMap<string, readonly string[]>
  readonly events: EventDraft[]
}

/**
 * The supplier of free request lines in the pool, inside the caller's transaction (FR-P2P-001 · S10-11 ADR-206): the
 * supplier is active, every line is in the pool, and none is held by an RFx — except, for an award, by the award's own
 * RFx (INV-RFX-03). It checks no capability (procurement.assign_supplier checks po.create; an award's authority is its
 * approval) and starts no urgent round (the command does that; an award consolidates its own lines).
 */
export async function assignSupplierInTx(tx: TenantTx, ctx: Ctx, input: { readonly requestLineIds: readonly string[]; readonly supplierId: string | null; readonly award?: AssignByAward }): Promise<Fail | SupplierAssigned> {
  const lineIds = [...new Set(input.requestLineIds)]
  if (input.supplierId) {
    const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId }, select: { status: true } })
    if (!supplier) return fail('VALIDATION_FAILED', 'unknown supplier', { field: 'supplierId', reason: 'SUPPLIER' })
    if (supplier.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 'the supplier is inactive', { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' })
  }
  const lines = await tx.requestLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, requestId: true, supplierId: true, rfxEventId: true } })
  if (lines.length !== lineIds.length) return fail('NOT_FOUND', 'request line not found')
  const requestIds = await lockRowsForUpdate(
    tx,
    'Request',
    ctx.organizationId,
    lines.map((l) => l.requestId),
  )
  // S10 (INV-RFX-03): a line in an RFx that has not ended gets its supplier from the award, never here (LINE_IN_RFX);
  // read after the lock, as rfx.create takes the same lock before it holds a line. The award's own RFx is no obstacle.
  const inRfx = await tx.requestLine.findMany({
    where: { id: { in: lineIds }, rfxEventId: { not: null }, ...(input.award ? { NOT: { rfxEventId: input.award.rfxEventId } } : {}) },
    select: { id: true, rfxEvent: { select: { id: true, number: true } } },
  })
  if (inRfx.length) {
    return fail('VALIDATION_FAILED', 'a line in an RFx gets its supplier from the award', { field: 'requestLineIds', reason: 'LINE_IN_RFX', requestLineIds: inRfx.map((l) => l.id), rfx: [...new Set(inRfx.map((l) => l.rfxEvent!.number ?? l.rfxEvent!.id))] })
  }
  const free = new Set((await freeLines(tx, { requestIds })).map((l) => l.requestLineId))
  const notInPool = lineIds.filter((id) => !free.has(id))
  if (notInPool.length) return fail('VALIDATION_FAILED', 'only lines in the pool get a supplier here', { field: 'requestLineIds', reason: 'LINE_NOT_IN_POOL', requestLineIds: notInPool })
  const changed = lines.filter((l) => l.supplierId !== input.supplierId)
  // an award's lines that have its winner already need nothing more (its approval goes on); a person asked for nothing
  if (changed.length === 0) return input.award ? { ok: true, byRequest: new Map(), events: [] } : fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
  await tx.requestLine.updateMany({ where: { id: { in: changed.map((l) => l.id) } }, data: { supplierId: input.supplierId } })
  const byRequest = new Map<string, string[]>()
  for (const l of changed) byRequest.set(l.requestId, [...(byRequest.get(l.requestId) ?? []), l.id])
  const events: EventDraft[] = [...byRequest].map(([requestId, ids]) => ({
    type: 'request.supplier_assigned',
    aggregateType: 'Request',
    aggregateId: requestId,
    data: { requestLineIds: ids, supplierId: input.supplierId, ...(input.award ? { via: 'AWARD', awardDecisionId: input.award.awardDecisionId, onBehalfOfMemberId: input.award.onBehalfOfMemberId } : {}) },
  }))
  return { ok: true, byRequest, events }
}

export const assignSupplierCommand = defineCommand({
  name: 'procurement.assign_supplier',
  capability: 'po.create',
  input: AssignSupplierInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ assigned: number; purchaseOrderIds: readonly string[] }>> {
    const ok = await authorize(tx, ctx, 'po.create')
    if (!ok.ok) return { ok: false, error: ok.error }
    const assigned = await assignSupplierInTx(tx, ctx, { requestLineIds: input.requestLineIds, supplierId: input.supplierId })
    if (!assigned.ok) return assigned
    const events = [...assigned.events]
    // BR-CONS-02: an urgent request does not wait for the round
    let purchaseOrderIds: readonly string[] = []
    if (input.supplierId) {
      // TODO(NEW-50): a request priced with VAT is never drafted until NEW-50 is decided, so it starts no urgent round
      const urgent = await tx.request.findMany({ where: { id: { in: [...assigned.byRequest.keys()] }, urgency: 'URGENT', priceIncludesVat: false }, select: { id: true } })
      if (urgent.length) {
        const run = await consolidateInTx(tx, ctx, { trigger: 'URGENT', requestIds: urgent.map((r) => r.id) })
        purchaseOrderIds = run.purchaseOrderIds
        events.push(...run.events)
      }
    }
    return { ok: true, result: { assigned: [...assigned.byRequest.values()].reduce((n, ids) => n + ids.length, 0), purchaseOrderIds }, events }
  },
})

export function assignSupplier(ctx: Ctx, input: z.input<typeof AssignSupplierInput>, options: RunOptions) {
  return runCommand(ctx, assignSupplierCommand, input, options)
}
