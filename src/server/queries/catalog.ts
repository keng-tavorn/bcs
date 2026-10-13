import type { Ctx } from '@/server/context'
import { escapeLike } from '@/server/db/like'
import { forTenant } from '@/server/db/tenant'

// The catalogue as rows (S6-10 · FR-INT-102): its items with the agreed prices of a Thai calendar day, read for the
// screens. No rights here (queries cannot import authz): src/server/services/catalog/view.ts checks catalog.view and
// catalog.manage. Money as satang; dates as YYYY-MM-DD of the period [validFrom, validTo).

/** The most items one search returns */
export const CATALOG_LIST_LIMIT = 200

export interface CatalogAgreementRow {
  readonly id: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: string
  readonly unitPriceSatang: bigint
  readonly validFrom: string
  readonly validTo: string
  readonly sourceRef: string | null
  readonly endedAt: Date | null
}

export interface CatalogItemRow {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly uom: string
  readonly categoryCode: string
  readonly isService: boolean
  readonly accountCode: string | null
  readonly whtIncomeType: string | null
  readonly refUnitPriceSatang: bigint
  readonly active: boolean
  /** The agreements in effect on the day asked, or every agreement that has not ended before it (allAgreements) */
  readonly agreements: readonly CatalogAgreementRow[]
}

const day = (d: Date) => d.toISOString().slice(0, 10)
const dateOf = (yyyyMmDd: string) => new Date(`${yyyyMmDd}T00:00:00Z`)

export interface CatalogSearch {
  /** Part of the code or the name */
  readonly q?: string
  readonly includeInactive?: boolean
  /** The Thai calendar day the agreements are of */
  readonly day: string
  /** Every agreement still in effect or still to come on that day, not only those in effect (the manage page) */
  readonly allAgreements?: boolean
  readonly ids?: readonly string[]
}

export async function searchCatalog(ctx: Ctx, search: CatalogSearch): Promise<{ rows: CatalogItemRow[]; total: number }> {
  const db = forTenant(ctx.organizationId)
  const q = (search.q ?? '').trim()
  const date = dateOf(search.day)
  const where = {
    ...(search.includeInactive ? {} : { active: true }),
    ...(search.ids ? { id: { in: [...search.ids] } } : {}),
    ...(q ? { OR: [{ code: { contains: escapeLike(q), mode: 'insensitive' as const } }, { nameTh: { contains: escapeLike(q), mode: 'insensitive' as const } }, { nameEn: { contains: escapeLike(q), mode: 'insensitive' as const } }] } : {}),
  }
  const [total, items] = await Promise.all([
    db.catalogItem.count({ where }),
    db.catalogItem.findMany({
      where,
      orderBy: { code: 'asc' },
      take: CATALOG_LIST_LIMIT,
      include: {
        priceAgreements: {
          where: search.allAgreements ? { validTo: { gt: date } } : { validFrom: { lte: date }, validTo: { gt: date } },
          orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
          include: { supplier: { select: { code: true, nameTh: true } } },
        },
      },
    }),
  ])
  return {
    total,
    rows: items.map((i) => ({
      id: i.id,
      code: i.code,
      nameTh: i.nameTh,
      nameEn: i.nameEn,
      uom: i.uom,
      categoryCode: i.categoryCode,
      isService: i.isService,
      accountCode: i.accountCode,
      whtIncomeType: i.whtIncomeType,
      refUnitPriceSatang: i.refUnitPriceSatang,
      active: i.active,
      agreements: i.priceAgreements.map((a) => ({
        id: a.id,
        supplierId: a.supplierId,
        supplierCode: a.supplier.code,
        supplierName: a.supplier.nameTh,
        unitPriceSatang: a.unitPriceSatang,
        validFrom: day(a.validFrom),
        validTo: day(a.validTo),
        sourceRef: a.sourceRef,
        endedAt: a.endedAt,
      })),
    })),
  }
}

/** The active suppliers an agreed price can be with (the manage page) */
export async function activeSupplierChoices(ctx: Ctx): Promise<Array<{ id: string; code: string; nameTh: string }>> {
  return forTenant(ctx.organizationId).supplier.findMany({ where: { status: 'ACTIVE' }, orderBy: { code: 'asc' }, select: { id: true, code: true, nameTh: true } })
}
