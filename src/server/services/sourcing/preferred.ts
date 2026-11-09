import { preferredWindow } from '@/core/sourcing'
import { sourcingSettingsOf } from '@/lib/org-settings'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'

// Preferred suppliers from an award (S10-11 · BR-RFX-14 · §8.12 FR-SRC-204 AC6 · OQ-210 · GC-SRC-29 30): when an award is
// approved each winner becomes a preferred supplier of the RFx's category for [the Thai day of the approval, +
// preferredSupplierDays). A pair (category, supplier) whose row still runs into that period is extended to its end
// instead of made again, so the rows of a pair never overlap; pairs of other suppliers of the same category may (a split
// award, several RFx). S10-13 adds the rows procurement sets itself (MANUAL), their end, the request form and the page.

const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const dateOf = (day: string) => new Date(`${day}T00:00:00Z`)

/** The preferred-supplier rows of an approved award, inside its decision's transaction (ctx: the award's submitter) */
export async function preferFromAward(
  tx: TenantTx,
  ctx: Ctx,
  input: { readonly awardDecisionId: string; readonly categoryCode: string; readonly supplierIds: readonly string[] },
): Promise<{ readonly preferredSupplierIds: string[]; readonly events: EventDraft[] }> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
  const window = preferredWindow(ctx.now, sourcingSettingsOf(org.settings).preferredSupplierDays)
  // one supplier's rows at a time, so two awards approved together never make two rows of one pair
  const suppliers = await lockRowsForUpdate(tx, 'Supplier', ctx.organizationId, [...new Set(input.supplierIds)])
  const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
  const preferredSupplierIds: string[] = []
  const events: EventDraft[] = []
  for (const supplierId of suppliers) {
    const overlapping = await tx.preferredSupplier.findMany({
      where: { categoryCode: input.categoryCode, supplierId, endedAt: null, validFrom: { lt: dateOf(window.validTo) }, validTo: { gt: dateOf(window.validFrom) } },
      orderBy: { validTo: 'desc' },
      select: { id: true, validTo: true },
    })
    const latest = overlapping[0]
    if (latest) {
      preferredSupplierIds.push(latest.id)
      const from = dayOf(latest.validTo)
      if (from < window.validTo) {
        await tx.preferredSupplier.update({ where: { id: latest.id }, data: { validTo: dateOf(window.validTo) } })
        events.push({ type: 'preferred_supplier.extended', aggregateType: 'PreferredSupplier', aggregateId: latest.id, data: { categoryCode: input.categoryCode, supplierId, from, to: window.validTo, awardDecisionId: input.awardDecisionId } })
      }
      continue
    }
    const row = await tx.preferredSupplier.create({
      data: { organizationId: ctx.organizationId, categoryCode: input.categoryCode, supplierId, validFrom: dateOf(window.validFrom), validTo: dateOf(window.validTo), source: 'SOURCING', awardDecisionId: input.awardDecisionId, createdById: memberId },
      select: { id: true },
    })
    preferredSupplierIds.push(row.id)
    events.push({ type: 'preferred_supplier.created', aggregateType: 'PreferredSupplier', aggregateId: row.id, data: { categoryCode: input.categoryCode, supplierId, validFrom: window.validFrom, validTo: window.validTo, source: 'SOURCING', awardDecisionId: input.awardDecisionId } })
  }
  return { preferredSupplierIds, events }
}
