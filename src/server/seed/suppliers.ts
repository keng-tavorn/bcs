import { systemCtx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { appendEvents, type EventDraft } from '@/server/events/append'
import type { parseSites, parseSuppliers } from './sheets'

// Suppliers and delivery sites of the demo organization (spec Appendix A, S4-02): sheets Suppliers and Sites of
// docs/inputs/BCS_inputs_v1_demo.xlsx. Local and staging only (prisma/seed.ts checks APP_ENV). The seeded suppliers are
// registered as checked against the registry stub (BR-SUP-05: their tax ids are synthetic). Running again adds
// nothing: suppliers and sites that exist are left as they are.

export interface SupplierSheets {
  readonly suppliers: ReturnType<typeof parseSuppliers>
  readonly sites: ReturnType<typeof parseSites>
}

export interface SupplierSeedReport {
  readonly suppliers: number
  readonly sites: number
}

export async function seedSuppliers(organizationId: string, sheets: SupplierSheets, now: Date): Promise<SupplierSeedReport> {
  const ctx = systemCtx(organizationId, now, 'seed')
  return forTenant(organizationId).$transaction(async (tx) => {
    const report = { suppliers: 0, sites: 0 }
    const events: EventDraft[] = []
    const existingSuppliers = new Set((await tx.supplier.findMany({ select: { code: true } })).map((s) => s.code))
    for (const s of sheets.suppliers) {
      if (existingSuppliers.has(s.code)) continue
      const row = await tx.supplier.create({
        data: {
          organizationId,
          code: s.code,
          nameTh: s.nameTh,
          taxId: s.taxId,
          branchCode: s.branchCode,
          isVatRegistered: s.vatRegistered,
          email: s.email,
          phone: s.phone,
          category: s.category,
          expressVendorCode: s.expressVendorCode,
          registrySource: 'STUB',
          registryCheckedAt: now,
        },
        select: { id: true },
      })
      events.push({
        type: 'supplier.created',
        aggregateType: 'Supplier',
        aggregateId: row.id,
        data: { code: s.code, taxId: s.taxId, branchCode: s.branchCode, isForeign: false, registrySource: 'STUB', via: 'SEED' },
      })
      report.suppliers++
    }
    const existingSites = new Set((await tx.deliverySite.findMany({ select: { code: true } })).map((s) => s.code))
    for (const site of sheets.sites) {
      if (existingSites.has(site.code)) continue
      await tx.deliverySite.create({ data: { organizationId, code: site.code, nameTh: site.nameTh, address: site.address } })
      report.sites++
    }
    if (events.length) await appendEvents(tx, ctx, events)
    return report
  })
}
