import type { Ctx } from '@/server/context'
import { listCatalog, type CatalogItemDto } from '@/server/services/catalog/view'
import type { CatalogItemOption } from '@/ui/request-form/types'

// The catalogue items as the request form takes them (S6-10 · FR-INT-102): only what a line uses — its name, unit,
// category, reference price and the agreed prices in effect today with their suppliers — never the accounting fields
// or the agreements' sources. Read through listCatalog, which checks catalog.view.

export function catalogOption(item: CatalogItemDto): CatalogItemOption {
  return {
    id: item.id,
    code: item.code,
    nameTh: item.nameTh,
    nameEn: item.nameEn,
    uom: item.uom,
    categoryCode: item.categoryCode,
    refUnitPriceSatang: item.refUnitPriceSatang,
    agreements: item.agreements.map((a) => ({ supplierId: a.supplierId, supplierCode: a.supplierCode, supplierName: a.supplierName, unitPriceSatang: a.unitPriceSatang })),
  }
}

/**
 * The items a draft's lines name, with today's agreed prices, for the form to show them again (an item taken out of the
 * catalogue since is not among them: the form says so on its line). A member who may not read the catalogue gets none.
 */
export async function draftCatalogItems(ctx: Ctx, lines: ReadonlyArray<{ readonly catalogItemId: string | null }>): Promise<CatalogItemOption[]> {
  const ids = [...new Set(lines.map((l) => l.catalogItemId).filter((id): id is string => Boolean(id)))]
  if (ids.length === 0) return []
  const result = await listCatalog(ctx, { ids })
  return result.ok ? result.data.items.map(catalogOption) : []
}
