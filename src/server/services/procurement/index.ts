import { z } from 'zod'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { consolidateInTx } from './consolidate'
import { freeLines } from './pool'

export { consolidateNow, runScheduledConsolidation } from './consolidate'
export { countPoolLines, listPool, type PoolFilter, type PoolLineDto } from './pool-view'

// The procurement pool (spec FR-P2P-001): PROCUREMENT chooses the supplier of approved request lines, many at once
// (AC2), or takes the choice back. Only lines with something left to order can change: a line already on a draft PO
// changes on that PO (BR-CONS-04). Lines of an urgent request are drafted at once when they get their supplier
// (BR-CONS-02); the others wait for the round.

type FailCode = 'VALIDATION_FAILED' | 'NOT_FOUND'
const fail = (code: FailCode, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

const AssignSupplierInput = z.strictObject({
  requestLineIds: z.array(z.uuid()).min(1).max(500),
  /** null takes the choice back */
  supplierId: z.uuid().nullable(),
})

export const assignSupplierCommand = defineCommand({
  name: 'procurement.assign_supplier',
  capability: 'po.create',
  input: AssignSupplierInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ assigned: number; purchaseOrderIds: readonly string[] }>> {
    const ok = await authorize(tx, ctx, 'po.create')
    if (!ok.ok) return { ok: false, error: ok.error }
    const lineIds = [...new Set(input.requestLineIds)]
    if (input.supplierId) {
      const supplier = await tx.supplier.findFirst({ where: { id: input.supplierId }, select: { status: true } })
      if (!supplier) return fail('VALIDATION_FAILED', 'unknown supplier', { field: 'supplierId', reason: 'SUPPLIER' })
      if (supplier.status !== 'ACTIVE') return fail('VALIDATION_FAILED', 'the supplier is inactive', { field: 'supplierId', reason: 'SUPPLIER_INACTIVE' })
    }
    const lines = await tx.requestLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, requestId: true, supplierId: true } })
    if (lines.length !== lineIds.length) return fail('NOT_FOUND', 'request line not found')
    const requestIds = await lockRowsForUpdate(
      tx,
      'Request',
      ctx.organizationId,
      lines.map((l) => l.requestId),
    )
    const free = new Set((await freeLines(tx, { requestIds })).map((l) => l.requestLineId))
    const notInPool = lineIds.filter((id) => !free.has(id))
    if (notInPool.length) return fail('VALIDATION_FAILED', 'only lines in the pool get a supplier here', { field: 'requestLineIds', reason: 'LINE_NOT_IN_POOL', requestLineIds: notInPool })
    const changed = lines.filter((l) => l.supplierId !== input.supplierId)
    if (changed.length === 0) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'NO_CHANGE' })
    await tx.requestLine.updateMany({ where: { id: { in: changed.map((l) => l.id) } }, data: { supplierId: input.supplierId } })
    const byRequest = new Map<string, string[]>()
    for (const l of changed) byRequest.set(l.requestId, [...(byRequest.get(l.requestId) ?? []), l.id])
    const events: EventDraft[] = [...byRequest].map(([requestId, ids]) => ({
      type: 'request.supplier_assigned',
      aggregateType: 'Request',
      aggregateId: requestId,
      data: { requestLineIds: ids, supplierId: input.supplierId },
    }))
    // BR-CONS-02: an urgent request does not wait for the round
    let purchaseOrderIds: readonly string[] = []
    if (input.supplierId) {
      // TODO(NEW-50): a request priced with VAT is never drafted until NEW-50 is decided, so it starts no urgent round
      const urgent = await tx.request.findMany({ where: { id: { in: [...byRequest.keys()] }, urgency: 'URGENT', priceIncludesVat: false }, select: { id: true } })
      if (urgent.length) {
        const run = await consolidateInTx(tx, ctx, { trigger: 'URGENT', requestIds: urgent.map((r) => r.id) })
        purchaseOrderIds = run.purchaseOrderIds
        events.push(...run.events)
      }
    }
    return { ok: true, result: { assigned: changed.length, purchaseOrderIds }, events }
  },
})

export function assignSupplier(ctx: Ctx, input: z.input<typeof AssignSupplierInput>, options: RunOptions) {
  return runCommand(ctx, assignSupplierCommand, input, options)
}
