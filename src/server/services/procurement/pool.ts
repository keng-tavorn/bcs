import { lineNet, lineNetsBeforeVat, parseQuantity, roundHalfUpDiv, type Satang } from '@/core/money/math'
import { formatQuantity } from '@/core/receiving'
import type { TenantTx } from '@/server/db/tenant'

// The procurement pool (spec FR-P2P-001, §7.10): the approved request lines with a quantity nobody has ordered yet.
// What is left of a line = its quantity − what was cancelled − what POs still order (PoLineSource of every PO that is
// not REJECTED or CANCELLED: a rejected PO, or one cancelled with RETURN_TO_POOL, gives its lines back, BR-BUD-06).
// Quantities are decimal text scaled by 10⁴ (§6.1); budget amounts are satang before VAT (BR-BUD-03).
//
// A line keeps the unit price its request states. A request whose prices include VAT has no unit price before VAT
// without rounding one, which BR-MONEY-02 does not allow (only line amounts, document VAT, withholding tax and
// largest-remainder shares are rounded): 3 × 100.00 including VAT 7% would become a draft PO of 300.01 against the
// 300.00 approved. Until the user decides how such a request becomes PO lines (NEW-50), its lines stay in the pool
// and no round drafts them (draftBlock).

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
  /** The request's unit price as it states it: before VAT, or with VAT included when `priceIncludesVat` */
  readonly unitPriceSatang: Satang
  /** The request's prices include VAT (a document-level choice, §6.1) */
  readonly priceIncludesVat: boolean
}

/** Why no round drafts a line although it has its supplier */
export type DraftBlock = 'PRICE_INCLUDES_VAT'

/**
 * What keeps a consolidation round (scheduled, by hand or urgent) from putting a free line on a draft PO, or null when
 * nothing does once the line has its supplier. A request whose prices include VAT waits for NEW-50: a draft PO is
 * priced before VAT, and its unit price before VAT cannot be had without a rounding BR-MONEY-02 does not allow.
 */
export function draftBlock(line: Pick<FreeLine, 'priceIncludesVat'>): DraftBlock | null {
  // TODO(NEW-50): the user chooses (a) VAT-inclusive POs grouped apart (BR-CONS-01) or (b) a fifth rounding point
  return line.priceIncludesVat ? 'PRICE_INCLUDES_VAT' : null
}

const scaled = (d: { toString(): string }) => parseQuantity(d.toString())

/**
 * BR-BUD-05: what ordering `quantity` (×10⁴) of a request line gives back to the request when the PO is approved,
 * rounded half up once. A request priced before VAT: the quantity ordered × the request's unit price — the amount of a
 * line (BR-MONEY-02 (1)), so a PO line at the request's own price gives back exactly its own amount. Never the share of
 * the line's amount, which was rounded already: 2.4 of 2.5 × 10.01 gives back 24.02, not 24.03 from 25.03 × 2.4 ÷ 2.5.
 * Only a request whose prices include VAT has no unit price before VAT: ADR-038 item 11 then shares the line's amount
 * before VAT by quantity (quantity × amount before VAT ÷ the line's quantity) — and such a line reaches no PO until
 * NEW-50 is decided (draftBlock).
 * Each part is rounded on its own, so the parts of a line can give back a satang more or less than the line reserved
 * when more than one of them is a fraction whose amount is not a whole satang: 2.5 × 10.01 (25.03) ordered as 0.1 and
 * 2.4 gives back 1.00 + 24.02 = 25.02, and 4 × 2,500.25 (10,001.00) as 0.5 and 3.5 gives back 1,250.13 + 8,750.88 =
 * 10,001.01. Approving never gives back more than the line still reserves (purchase-orders/budget.ts commitForPo), and
 * nothing gives back a satang left reserved. Parts in whole units never differ.
 * A PO cancelled with RETURN_TO_POOL reserves its releasable again as stored (BR-BUD-06), not the capped amount its
 * approval gave back: 0.3 × 10.08 (3.02) ordered as 0.1 and 0.2 gives back 1.01 + 2.01 when both are approved and
 * reserves 1.01 + 2.02 = 3.03 again when both are cancelled, a satang above the line's amount (INV-BUD-03).
 * TODO(NEW-65): the user decides how a line ordered in parts ends at exactly what it reserved, both when its
 * parts are approved and when they come back to the pool (pending NEW item)
 */
export function releasableFor(line: Pick<FreeLine, 'quantity' | 'netBeforeVat' | 'unitPriceSatang' | 'priceIncludesVat'>, quantity: bigint): Satang {
  if (!line.priceIncludesVat) return lineNet(formatQuantity(quantity), line.unitPriceSatang)
  // TODO(NEW-50): a request priced with VAT is kept off POs (draftBlock); this is ADR-038 item 11 for when it is not
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
          // S6-17 (BR-BUD-16): a line on its own budget line orders on it, so its PO line holds and spends there
          budgetLineId: true,
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
        budgetLineId: l.budgetLineId ?? r.budgetLineId!,
        quantity,
        free,
        netBeforeVat,
        unitPriceSatang: l.unitPriceSatang,
        priceIncludesVat: r.priceIncludesVat,
      })
    })
  }
  return out
}

export interface LineBasis {
  readonly requestId: string
  /** ×10⁴ */
  readonly quantity: bigint
  readonly cancelled: bigint
  readonly netBeforeVat: Satang
  /** The request's unit price as it states it, and whether its prices include VAT (what releasableFor needs) */
  readonly unitPriceSatang: Satang
  readonly priceIncludesVat: boolean
  /** What each source of a PO that still orders the line orders, ×10⁴ (by PoLineSource id) */
  readonly ordering: ReadonlyMap<string, bigint>
}

/** The quantity, price and amount before VAT of request lines, with what POs still order of them (BR-BUD-05, FR-P2P-003 AC2) */
export async function requestLineBasis(tx: TenantTx, requestLineIds: readonly string[]): Promise<Map<string, LineBasis>> {
  const requestIds = [...new Set((await tx.requestLine.findMany({ where: { id: { in: [...requestLineIds] } }, select: { requestId: true } })).map((l) => l.requestId))]
  const requests = await tx.request.findMany({
    where: { id: { in: requestIds } },
    select: {
      id: true,
      priceIncludesVat: true,
      vatRateBp: true,
      lines: {
        orderBy: { lineNo: 'asc' },
        select: {
          id: true,
          quantity: true,
          cancelledQuantity: true,
          unitPriceSatang: true,
          vatable: true,
          poSources: { where: { poLine: { po: { status: { in: [...ORDERING_PO_STATUSES] } } } }, select: { id: true, quantity: true } },
        },
      },
    },
  })
  const out = new Map<string, LineBasis>()
  for (const r of requests) {
    const nets = lineNetsBeforeVat(
      r.lines.map((l) => ({ quantity: l.quantity.toString(), unitPriceSatang: l.unitPriceSatang, vatable: l.vatable })),
      r.vatRateBp ?? 0,
      r.priceIncludesVat,
    )
    r.lines.forEach((l, i) =>
      out.set(l.id, {
        requestId: r.id,
        quantity: scaled(l.quantity),
        cancelled: scaled(l.cancelledQuantity),
        netBeforeVat: nets[i]!,
        unitPriceSatang: l.unitPriceSatang,
        priceIncludesVat: r.priceIncludesVat,
        ordering: new Map(l.poSources.map((s) => [s.id, scaled(s.quantity)])),
      }),
    )
  }
  return out
}
