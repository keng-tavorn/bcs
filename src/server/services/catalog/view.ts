import { z } from 'zod'
import { agreementDay } from '@/core/pricing'
import { err, ok, type Result } from '@/core/result'
import { authorize, isAllowed } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { activeSupplierChoices, CATALOG_LIST_LIMIT, searchCatalog, type CatalogItemRow } from '@/server/queries/catalog'

// The catalogue as its screens show it (S6-10 · FR-INT-102 · §9.1 /catalog and /catalog/manage): catalog.view on every
// read — every member searches it and sees the reference price and the agreed prices in effect today — and
// catalog.manage for the manage page, which also lists inactive items and agreements still to come, with the active
// suppliers to choose from. Read only: changes go through ./index.ts. Money as satang text (BR-MONEY-01 DTOs).

export interface CatalogAgreementDto {
  readonly id: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: string
  readonly unitPriceSatang: string
  /** YYYY-MM-DD, included */
  readonly validFrom: string
  /** YYYY-MM-DD, not included */
  readonly validTo: string
  readonly sourceRef: string | null
  /** In effect today (the manage page lists those to come too) */
  readonly inEffect: boolean
  readonly ended: boolean
}

export interface CatalogItemDto {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly uom: string
  readonly categoryCode: string
  readonly isService: boolean
  readonly accountCode: string | null
  readonly whtIncomeType: string | null
  readonly refUnitPriceSatang: string
  readonly active: boolean
  readonly agreements: readonly CatalogAgreementDto[]
}

export interface CatalogListDto {
  readonly items: readonly CatalogItemDto[]
  /** Items that match, of which at most `limit` are listed */
  readonly total: number
  readonly limit: number
  /** YYYY-MM-DD: the Thai calendar day of the agreed prices */
  readonly today: string
  /** catalog.manage: the link to the manage page */
  readonly canManage: boolean
}

export interface CatalogManageDto extends CatalogListDto {
  readonly suppliers: ReadonlyArray<{ readonly id: string; readonly code: string; readonly nameTh: string }>
}

function itemDto(row: CatalogItemRow, today: string): CatalogItemDto {
  return {
    ...row,
    refUnitPriceSatang: row.refUnitPriceSatang.toString(),
    agreements: row.agreements.map((a) => ({
      id: a.id,
      supplierId: a.supplierId,
      supplierCode: a.supplierCode,
      supplierName: a.supplierName,
      unitPriceSatang: a.unitPriceSatang.toString(),
      validFrom: a.validFrom,
      validTo: a.validTo,
      sourceRef: a.sourceRef,
      inEffect: a.validFrom <= today && today < a.validTo,
      ended: a.endedAt !== null,
    })),
  }
}

const Filter = z.object({ q: z.string().max(100).optional() })
/** The request form's own items: those its saved lines name (S6-10), to show their agreed prices again */
const ListFilter = Filter.extend({ ids: z.array(z.uuid()).max(CATALOG_LIST_LIMIT).optional() })

/** /catalog and the request form's picker: active items matching `q` (and among `ids` when given), with today's agreed prices */
export async function listCatalog(ctx: Ctx, filter: { q?: string; ids?: readonly string[] } = {}): Promise<Result<CatalogListDto>> {
  const principal = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'catalog.view'))
  if (!principal.ok) return err(principal.error.code, principal.error.message, principal.error.details)
  const parsed = ListFilter.safeParse(filter)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the search is too long', { field: parsed.error.issues[0]?.path[0] === 'ids' ? 'ids' : 'q' })
  const today = agreementDay(ctx.now)
  const found = await searchCatalog(ctx, { ...(parsed.data.q ? { q: parsed.data.q } : {}), ...(parsed.data.ids ? { ids: parsed.data.ids } : {}), day: today })
  return ok({ items: found.rows.map((r) => itemDto(r, today)), total: found.total, limit: CATALOG_LIST_LIMIT, today, canManage: isAllowed(principal.data, 'catalog.manage') })
}

/** /catalog/manage: every item, inactive too, with the agreed prices in effect and to come, and the active suppliers */
export async function getCatalogManage(ctx: Ctx, filter: { q?: string } = {}): Promise<Result<CatalogManageDto>> {
  const allowed = await forTenant(ctx.organizationId).$transaction((tx) => authorize(tx, ctx, 'catalog.manage'))
  if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
  const parsed = Filter.safeParse(filter)
  if (!parsed.success) return err('VALIDATION_FAILED', 'the search is too long', { field: 'q' })
  const today = agreementDay(ctx.now)
  const [found, suppliers] = await Promise.all([
    searchCatalog(ctx, { ...(parsed.data.q ? { q: parsed.data.q } : {}), day: today, includeInactive: true, allAgreements: true }),
    activeSupplierChoices(ctx),
  ])
  return ok({ items: found.rows.map((r) => itemDto(r, today)), total: found.total, limit: CATALOG_LIST_LIMIT, today, canManage: true, suppliers })
}
