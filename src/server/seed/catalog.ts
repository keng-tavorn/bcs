import { agreementDay } from '@/core/pricing'
import { MS_PER_DAY } from '@/lib/constants'
import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { CatalogSheetItem } from './sheets'

// The catalogue of the phase-1 organization (S6-10 · FR-INT-102 AC1): sheet Items of docs/inputs/BCS_inputs_p1.xlsx, one
// CatalogItem per row, and the agreed price of the rows that name a supplier, for the fiscal year in which the seed runs
// (validFrom = its first day, validTo = the first day of the next), so a seed run on any day has agreements in effect.
// Local and staging only. Running again adds nothing: items and agreements that exist are left as they are.

export interface CatalogSeedReport {
  readonly items: number
  readonly agreements: number
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

export async function seedCatalog(organizationId: string, items: readonly CatalogSheetItem[], now: Date): Promise<CatalogSeedReport> {
  if (items.length === 0) return { items: 0, agreements: 0 }
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const today = new Date(`${agreementDay(now)}T00:00:00Z`)
    const year = await tx.fiscalYear.findFirst({ where: { startsOn: { lte: today }, endsOn: { gte: today } }, select: { startsOn: true, endsOn: true } })
    if (!year) throw new Error('ชีต Items: ไม่มีปีงบที่ครอบวันนี้ ราคาตกลงจึงไม่มีช่วงที่ใช้ได้ (seed งบก่อนแคตตาล็อก)')
    const validFrom = year.startsOn
    const validTo = new Date(year.endsOn.getTime() + MS_PER_DAY)
    const suppliers = new Map((await tx.supplier.findMany({ select: { id: true, code: true } })).map((s) => [s.code, s.id]))
    const existing = new Set((await tx.catalogItem.findMany({ select: { code: true } })).map((i) => i.code))
    const events: EventDraft[] = []
    const report = { items: 0, agreements: 0 }
    for (const item of items) {
      if (existing.has(item.code)) continue
      const supplierId = item.agreement ? suppliers.get(item.agreement.supplierCode) : undefined
      if (item.agreement && !supplierId) throw new Error(`ชีต Items ${item.code}: ไม่มีผู้ขาย ${item.agreement.supplierCode} ในชีต Suppliers`)
      const row = await tx.catalogItem.create({
        data: {
          organizationId,
          code: item.code,
          nameTh: item.nameTh,
          uom: item.uom,
          categoryCode: item.categoryCode,
          isService: item.isService,
          accountCode: item.accountCode,
          whtIncomeType: item.whtIncomeType,
          refUnitPriceSatang: item.refUnitPriceSatang,
        },
        select: { id: true },
      })
      events.push({ type: 'catalog_item.created', aggregateType: 'CatalogItem', aggregateId: row.id, data: { code: item.code, via: 'SEED' } })
      report.items++
      if (!item.agreement || !supplierId) continue
      const agreement = await tx.priceAgreement.create({
        data: { organizationId, catalogItemId: row.id, supplierId, unitPriceSatang: item.agreement.unitPriceSatang, validFrom, validTo, sourceRef: item.agreement.note },
        select: { id: true },
      })
      events.push({
        type: 'price_agreement.created',
        aggregateType: 'PriceAgreement',
        aggregateId: agreement.id,
        data: { catalogItemId: row.id, supplierId, unitPriceSatang: item.agreement.unitPriceSatang.toString(), validFrom: dayOf(validFrom), validTo: dayOf(validTo), via: 'SEED' },
      })
      report.agreements++
    }
    if (events.length) await appendEvents(tx, ctx, events)
    return report
  })
}

/**
 * The lines of the seeded history that are catalogue items (S6-10): the history makes its requests through the services
 * with the item's name and unit, so a line whose (description, uom) is an item's (nameTh, uom) is that item. Lines already
 * linked are left as they are; nothing else of the requests changes.
 */
export async function linkHistoryToCatalog(organizationId: string): Promise<{ lines: number }> {
  return forTenant(organizationId).$transaction(async (tx) => {
    let lines = 0
    for (const item of await tx.catalogItem.findMany({ select: { id: true, nameTh: true, uom: true } })) {
      lines += (await tx.requestLine.updateMany({ where: { description: item.nameTh, uom: item.uom, catalogItemId: null }, data: { catalogItemId: item.id } })).count
    }
    return { lines }
  })
}
