import { err, ok, type Result } from '@/core/result'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { freeLines } from './pool'

// The purchasing work in numbers for /liff/procurement (FR-LINE-303 AC4 · S17-04): how many lines wait in the pool (and
// how many of them are urgent) and how many POs are at each step procurement moves them through. Read only, for
// PROCUREMENT: procurement.pool.view is checked here, so anyone else gets FORBIDDEN and no number (the page shows that
// they may not see it). The lines are the pool's own (freeLines), so the count is the one /procurement/pool lists.

/** The PO steps procurement acts on or follows, in the order a PO goes through them */
export const PROCUREMENT_SUMMARY_PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] as const
export type ProcurementSummaryPoStatus = (typeof PROCUREMENT_SUMMARY_PO_STATUSES)[number]

export interface ProcurementSummaryDto {
  readonly poolLines: number
  readonly urgentLines: number
  readonly posByStatus: Readonly<Record<ProcurementSummaryPoStatus, number>>
}

export async function procurementSummary(ctx: Ctx): Promise<Result<ProcurementSummaryDto>> {
  const db = forTenant(ctx.organizationId)
  return db.$transaction(async (tx) => {
    const allowed = await authorize(tx, ctx, 'procurement.pool.view')
    if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
    const lines = await freeLines(tx)
    const counts = await Promise.all(PROCUREMENT_SUMMARY_PO_STATUSES.map((status) => tx.purchaseOrder.count({ where: { status } })))
    return ok({
      poolLines: lines.length,
      urgentLines: lines.filter((l) => l.urgent).length,
      posByStatus: Object.fromEntries(PROCUREMENT_SUMMARY_PO_STATUSES.map((status, i) => [status, counts[i]!])) as Record<ProcurementSummaryPoStatus, number>,
    })
  })
}
