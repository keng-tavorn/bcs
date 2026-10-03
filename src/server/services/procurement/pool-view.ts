import { lineNet, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_DAY } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { freeLines } from './pool'

// What PROCUREMENT sees in the pool (spec FR-P2P-001 AC1, AC3; §2.4 procurement.pool.view = PROCUREMENT): every
// approved request line with something left to order, filtered by supplier, delivery site, urgency and age, oldest
// approval first. A line without a supplier says so (BR-CONS-03) and waits for one.

export interface PoolFilter {
  /** A supplier's id, or NONE for the lines that still need one */
  readonly supplierId?: string
  readonly deliverySiteId?: string
  readonly urgency?: 'NORMAL' | 'URGENT'
  /** Approved at least this many whole days before now */
  readonly minAgeDays?: number
}

export interface PoolLineDto {
  readonly requestLineId: string
  readonly requestId: string
  readonly requestNo: string
  readonly requestTitle: string
  readonly requesterName: string
  readonly lineNo: number
  readonly description: string
  readonly kind: 'GOODS' | 'SERVICE'
  /** Left to order, decimal text */
  readonly quantity: string
  readonly uom: string
  readonly unitPriceSatang: Satang
  /** What is left × the unit price, before VAT */
  readonly netSatang: Satang
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string } | null
  /** BR-CONS-03: "ต้องเลือกผู้ขาย" */
  readonly needsSupplier: boolean
  readonly suggestedSupplierId: string | null
  readonly deliverySite: { readonly id: string; readonly code: string; readonly nameTh: string } | null
  readonly urgency: 'NORMAL' | 'URGENT'
  readonly approvedAt: string
  readonly ageDays: number
}

export async function listPool(ctx: Ctx, filter: PoolFilter = {}): Promise<Result<PoolLineDto[]>> {
  const db = forTenant(ctx.organizationId)
  const allowed = await db.$transaction((tx) => authorize(tx, ctx, 'procurement.pool.view'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const lines = await db.$transaction((tx) => freeLines(tx))
  const requestIds = [...new Set(lines.map((l) => l.requestId))]
  const [requests, suppliers, sites] = await Promise.all([
    db.request.findMany({ where: { id: { in: requestIds } }, select: { id: true, title: true, approvedAt: true, suggestedSupplierId: true, requester: { select: { displayNameTh: true } } } }),
    db.supplier.findMany({ where: { id: { in: [...new Set(lines.flatMap((l) => (l.supplierId ? [l.supplierId] : [])))] } }, select: { id: true, code: true, nameTh: true } }),
    db.deliverySite.findMany({ where: { id: { in: [...new Set(lines.flatMap((l) => (l.deliverySiteId ? [l.deliverySiteId] : [])))] } }, select: { id: true, code: true, nameTh: true } }),
  ])
  const requestOf = new Map(requests.map((r) => [r.id, r]))
  const supplierOf = new Map(suppliers.map((s) => [s.id, s]))
  const siteOf = new Map(sites.map((s) => [s.id, s]))
  const rows = lines.map((l): PoolLineDto => {
    const r = requestOf.get(l.requestId)!
    const approvedAt = r.approvedAt ?? ctx.now
    const quantity = formatQuantity(l.free)
    return {
      requestLineId: l.requestLineId,
      requestId: l.requestId,
      requestNo: l.requestNo,
      requestTitle: r.title,
      requesterName: r.requester.displayNameTh,
      lineNo: l.lineNo,
      description: l.description,
      kind: l.kind,
      quantity,
      uom: l.uom,
      unitPriceSatang: l.unitPriceBeforeVat,
      netSatang: lineNet(quantity, l.unitPriceBeforeVat),
      supplier: l.supplierId ? (supplierOf.get(l.supplierId) ?? null) : null,
      needsSupplier: l.supplierId === null,
      suggestedSupplierId: r.suggestedSupplierId,
      deliverySite: l.deliverySiteId ? (siteOf.get(l.deliverySiteId) ?? null) : null,
      urgency: l.urgent ? 'URGENT' : 'NORMAL',
      approvedAt: approvedAt.toISOString(),
      ageDays: Math.floor((ctx.now.getTime() - approvedAt.getTime()) / MS_PER_DAY),
    }
  })
  return ok(
    rows
      .filter((row) => {
        if (filter.supplierId === 'NONE' ? !row.needsSupplier : filter.supplierId && row.supplier?.id !== filter.supplierId) return false
        if (filter.deliverySiteId && row.deliverySite?.id !== filter.deliverySiteId) return false
        if (filter.urgency && row.urgency !== filter.urgency) return false
        return filter.minAgeDays === undefined || row.ageDays >= filter.minAgeDays
      })
      .sort((a, b) => a.approvedAt.localeCompare(b.approvedAt) || a.requestNo.localeCompare(b.requestNo, 'en', { numeric: true }) || a.lineNo - b.lineNo),
  )
}
