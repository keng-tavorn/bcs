import { roundHalfUpDiv, lineNetsBeforeVat, parseQuantity, type Satang } from '@/core/money/math'
import { QUANTITY_SCALE } from '@/core/money/constants'
import type { TenantTx } from '@/server/db/tenant'

// The procurement pool (spec FR-P2P-001, §7.10): the approved request lines with a quantity nobody has ordered yet.
// What is left of a line = its quantity − what was cancelled − what POs still order (PoLineSource of every PO that is
// not REJECTED or CANCELLED: a rejected PO, or one cancelled with RETURN_TO_POOL, gives its lines back, BR-BUD-06).
// Quantities are decimal text scaled by 10⁴ (§6.1); amounts are satang before VAT (BR-BUD-03).

/** POs whose sources still order their request lines */
export const ORDERING_PO_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const
/** Requests whose lines can be ordered (§6.4) */
export const POOL_REQUEST_STATUSES = ['APPROVED', 'PARTIALLY_ORDERED'] as const

export interface FreeLine {
  readonly requestLineId: string
  readonly requestId: string
  readonly requestNo: string
  readonly lineNo: number
  readonly description: string
  readonly categoryCode: string | null
  readonly uom: string
  readonly vatable: boolean
  readonly serviceEndDate: Date | null
  readonly kind: 'GOODS' | 'SERVICE'
  readonly supplierId: string | null
  readonly deliverySiteId: string | null
  readonly urgent: boolean
  readonly budgetLineId: string
  /** The line's quantity, ×10⁴ */
  readonly quantity: bigint
  /** Not ordered and not cancelled, ×10⁴ */
  readonly free: bigint
  /** The line's amount before VAT (the share of the document's when its prices include VAT, BR-BUD-05) */
  readonly netBeforeVat: Satang
  /** The price of one unit before VAT, rounded half up (equal to the line's unit price when it excludes VAT) */
  readonly unitPriceBeforeVat: Satang
}

const scaled = (d: { toString(): string }) => parseQuantity(d.toString())

/**
 * BR-BUD-05: what ordering `quantity` (×10⁴) of a request line gives back to the request when the PO is approved —
 * the quantity × the line's unit price, or for a document whose prices include VAT the quantity × the line's amount
 * before VAT ÷ its quantity — rounded half up once.
 */
export function releasableFor(line: Pick<FreeLine, 'quantity' | 'netBeforeVat'>, quantity: bigint): Satang {
  return roundHalfUpDiv(quantity * line.netBeforeVat, line.quantity)
}

/**
 * The free lines of requests in the pool. `requestIds` narrows to some requests; `withSupplierOnly` to lines
 * PROCUREMENT has chosen a supplier for. Lines with nothing left are left out.
 */
export async function freeLines(tx: TenantTx, filter: { requestIds?: readonly string[]; withSupplierOnly?: boolean } = {}): Promise<FreeLine[]> {
  const requests = await tx.request.findMany({
    where: {
      documentType: 'PURCHASE_REQUEST',
      status: { in: [...POOL_REQUEST_STATUSES] },
      ...(filter.requestIds ? { id: { in: [...filter.requestIds] } } : {}),
    },
    select: {
      id: true,
      number: true,
      urgency: true,
      deliverySiteId: true,
      budgetLineId: true,
      priceIncludesVat: true,
      vatRateBp: true,
      lines: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true,
          lineNo: true,
          description: true,
          categoryCode: true,
          uom: true,
          quantity: true,
          cancelledQuantity: true,
          unitPriceSatang: true,
          vatable: true,
          serviceEndDate: true,
          kind: true,
          supplierId: true,
          poSources: { where: { poLine: { po: { status: { in: [...ORDERING_PO_STATUSES] } } } }, select: { quantity: true } },
        },
      },
    },
  })
  const out: FreeLine[] = []
  for (const r of requests) {
    if (!r.number || !r.budgetLineId) continue
    const nets = lineNetsBeforeVat(
      r.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
      r.vatRateBp ?? 0,
      r.priceIncludesVat,
    )
    r.lines.forEach((l, i) => {
      const quantity = scaled(l.quantity)
      const ordered = l.poSources.reduce((sum, s) => sum + scaled(s.quantity), 0n)
      const free = quantity - scaled(l.cancelledQuantity) - ordered
      if (free <= 0n || (filter.withSupplierOnly && !l.supplierId)) return
      const netBeforeVat = nets[i]!
      out.push({
        requestLineId: l.id,
        requestId: r.id,
        requestNo: r.number!,
        lineNo: l.lineNo,
        description: l.description,
        categoryCode: l.categoryCode,
        uom: l.uom,
        vatable: l.vatable,
        serviceEndDate: l.serviceEndDate,
        kind: l.kind,
        supplierId: l.supplierId,
        deliverySiteId: r.deliverySiteId,
        urgent: r.urgency === 'URGENT',
        budgetLineId: r.budgetLineId!,
        quantity,
        free,
        netBeforeVat,
        unitPriceBeforeVat: r.priceIncludesVat ? roundHalfUpDiv(netBeforeVat * QUANTITY_SCALE, quantity) : l.unitPriceSatang,
      })
    })
  }
  return out
}
