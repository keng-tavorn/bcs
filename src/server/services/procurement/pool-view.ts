import { lineNet, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import { err, ok, type Result } from '@/core/result'
import { MS_PER_DAY } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { draftBlock, freeLines, type DraftBlock } from './pool'

// What PROCUREMENT sees in the pool (spec FR-P2P-001 AC1, AC3; §2.4 procurement.pool.view = PROCUREMENT): every
// approved request line with something left to order, filtered by supplier, delivery site, urgency and age, oldest
// approval first. A line without a supplier says so (BR-CONS-03) and waits for one. A line no round drafts even with
// its supplier says why (draftBlock: a request whose prices include VAT, NEW-50). Prices are the request's own, on its
// VAT basis: nothing is converted, so nothing is rounded beyond the line amount (BR-MONEY-02 (1)).

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
  /** The requester's display name in Thai, and in English when the member has one (the English page shows it) */
  readonly requesterName: string
  readonly requesterNameEn: string | null
  readonly lineNo: number
  readonly description: string
  readonly kind: 'GOODS' | 'SERVICE'
  /** Left to order, decimal text */
  readonly quantity: string
  readonly uom: string
  /** The request's unit price: before VAT, or with VAT included when `priceIncludesVat` */
  readonly unitPriceSatang: Satang
  /** What is left × the unit price (BR-MONEY-02 (1)), on the same VAT basis as the unit price */
  readonly amountSatang: Satang
  /** The request's prices include VAT: the unit price and the amount above include it */
  readonly priceIncludesVat: boolean
  readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string } | null
  /** BR-CONS-03: "ต้องเลือกผู้ขาย" */
  readonly needsSupplier: boolean
  /** Why no round drafts the line even with its supplier, or null: the next round drafts it once it has one */
  readonly draftBlock: DraftBlock | null
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
    db.request.findMany({ where: { id: { in: requestIds } }, select: { id: true, title: true, approvedAt: true, suggestedSupplierId: true, requester: { select: { displayNameTh: true, displayNameEn: true } } } }),
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
      requesterNameEn: r.requester.displayNameEn,
      lineNo: l.lineNo,
      description: l.description,
      kind: l.kind,
      quantity,
      uom: l.uom,
      unitPriceSatang: l.unitPriceSatang,
      amountSatang: lineNet(quantity, l.unitPriceSatang),
      priceIncludesVat: l.priceIncludesVat,
      supplier: l.supplierId ? (supplierOf.get(l.supplierId) ?? null) : null,
      needsSupplier: l.supplierId === null,
      draftBlock: draftBlock(l),
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
