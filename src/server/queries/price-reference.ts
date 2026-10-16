import { lineKey } from '@/core/duplicates'
import { cardBadge, priceReference, quoteRange, type CardBadge, type PriceSample } from '@/core/pricing'
import { rateFor, taxDateOf } from '@/core/vat'
import { MS_PER_DAY } from '@/lib/constants'
import { OrgSettingsSchema, s6SettingsOf } from '@/lib/org-settings'
import { listTaxRates } from '@/server/db/lookups'
import { forTenant, type TenantTx } from '@/server/db/tenant'

// What the price reference of a request reads (S6-11 · FR-DOA-101 · BR-PRC-01 · BR-PRC-04): its lines, quotations and
// agreed prices, who has or had a task on it or on a PO bought from it (BR-PRC-07), and the lines of POs approved in
// the window, keyed as BR-DUP-01 keys them (a PO line is a catalogue item when a request line it came from is one).
// No rights here: src/server/services/price-reference checks priceReference.view.

export interface PriceRequestFacts {
  readonly id: string
  readonly priceIncludesVat: boolean
  readonly vatRateBp: number | null
  readonly nonLowestQuoteReason: string | null
  readonly suggestedSupplierId: string | null
  readonly lines: ReadonlyArray<{
    readonly id: string
    readonly lineNo: number
    readonly description: string
    readonly uom: string
    readonly unitPriceSatang: bigint
    readonly catalogItemId: string | null
    readonly agreement: { readonly supplierName: string; readonly unitPriceSatang: bigint } | null
  }>
  readonly quotations: ReadonlyArray<{ readonly id: string; readonly supplierName: string; readonly amountSatang: bigint; readonly includesVat: boolean; readonly isSelected: boolean }>
  /** Who holds or held a task on the request's routes or on those of the POs bought from it, as assignee or principal */
  readonly assigneeMemberIds: readonly string[]
}

export async function priceRequestFacts(tx: TenantTx, requestId: string): Promise<PriceRequestFacts | null> {
  const request = await tx.request.findFirst({
    where: { id: requestId },
    select: {
      id: true,
      priceIncludesVat: true,
      vatRateBp: true,
      nonLowestQuoteReason: true,
      suggestedSupplierId: true,
      lines: {
        orderBy: { lineNo: 'asc' },
        select: { id: true, lineNo: true, description: true, uom: true, unitPriceSatang: true, catalogItemId: true, priceAgreement: { select: { unitPriceSatang: true, supplier: { select: { nameTh: true } } } } },
      },
      quotations: { orderBy: { createdAt: 'asc' }, select: { id: true, supplierName: true, amountSatang: true, includesVat: true, isSelected: true } },
    },
  })
  if (!request) return null
  const poIds = (await tx.poLineSource.findMany({ where: { requestLine: { requestId } }, select: { poLine: { select: { poId: true } } } })).map((s) => s.poLine.poId)
  const tasks = await tx.approvalTask.findMany({
    where: { step: { route: { OR: [{ subjectType: 'REQUEST' as const, subjectId: requestId }, ...(poIds.length ? [{ subjectType: 'PURCHASE_ORDER' as const, subjectId: { in: [...new Set(poIds)] } }] : [])] } } },
    select: { assigneeMemberId: true, principalMemberId: true },
  })
  return {
    id: request.id,
    priceIncludesVat: request.priceIncludesVat,
    vatRateBp: request.vatRateBp,
    nonLowestQuoteReason: request.nonLowestQuoteReason,
    suggestedSupplierId: request.suggestedSupplierId,
    lines: request.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      unitPriceSatang: l.unitPriceSatang,
      catalogItemId: l.catalogItemId,
      agreement: l.priceAgreement ? { supplierName: l.priceAgreement.supplier.nameTh, unitPriceSatang: l.priceAgreement.unitPriceSatang } : null,
    })),
    quotations: request.quotations,
    assigneeMemberIds: [...new Set(tasks.flatMap((t) => (t.principalMemberId ? [t.assigneeMemberId, t.principalMemberId] : [t.assigneeMemberId])))],
  }
}

/**
 * BR-PRC-01: the lines of POs approved in [from, to) and not rejected or cancelled whose key is one of `keys`, as
 * samples by key. Read in one query bounded by the window and the lines' descriptions and items (NEW-38).
 */
export async function priceSamples(
  tx: TenantTx,
  lines: ReadonlyArray<{ readonly description: string; readonly uom: string; readonly catalogItemId: string | null }>,
  from: Date,
  to: Date,
): Promise<Map<string, PriceSample[]>> {
  const keys = new Set(lines.map((l) => lineKey(l)))
  const items = [...new Set(lines.map((l) => l.catalogItemId).filter((id): id is string => Boolean(id)))]
  const descriptions = [...new Set(lines.map((l) => l.description))]
  const rows = await tx.poLine.findMany({
    where: {
      po: { approvedAt: { gte: from, lt: to }, status: { notIn: ['REJECTED', 'CANCELLED', 'DRAFT', 'PENDING_APPROVAL'] } },
      OR: [...(items.length ? [{ sources: { some: { requestLine: { catalogItemId: { in: items } } } } }] : []), { description: { in: descriptions } }],
    },
    orderBy: [{ po: { approvedAt: 'asc' } }, { id: 'asc' }],
    select: { description: true, uom: true, unitPriceSatang: true, po: { select: { approvedAt: true, priceIncludesVat: true } }, sources: { select: { requestLine: { select: { catalogItemId: true } } } } },
  })
  const out = new Map<string, PriceSample[]>()
  for (const r of rows) {
    const catalogItemId = r.sources.map((s) => s.requestLine.catalogItemId).find((id): id is string => Boolean(id)) ?? null
    const key = lineKey({ catalogItemId, description: r.description, uom: r.uom })
    if (!keys.has(key) || !r.po.approvedAt) continue
    out.set(key, [...(out.get(key) ?? []), { unitPriceSatang: r.unitPriceSatang, approvedAt: r.po.approvedAt, priceIncludesVat: r.po.priceIncludesVat }])
  }
  return out
}

// ---------- the reference itself (BR-PRC-01 to BR-PRC-05 · ADR-108) ----------

const PERCENT_TO_BP = 100

/** Money as satang text (BR-MONEY-01 DTOs) */
export interface PriceLineReferenceDto {
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly key: string
  readonly unitPriceSatang: string
  readonly count: number
  readonly excludedVatIncluded: number
  readonly minSatang: string | null
  readonly medianSatang: string | null
  readonly maxSatang: string | null
  readonly lastSatang: string | null
  readonly status: 'OK' | 'FEW_SAMPLES'
  readonly deviationBp: number | null
  readonly alert: 'HIGH' | 'LOW' | null
  readonly agreement: { readonly supplierName: string; readonly unitPriceSatang: string } | null
}

export interface PriceReferenceDto {
  readonly requestId: string
  readonly windowDays: number
  readonly minSamples: number
  readonly alertBp: number
  /** The request's prices include VAT: no deviation is computed (BR-PRC-03) */
  readonly requestIncludesVat: boolean
  readonly lines: readonly PriceLineReferenceDto[]
  readonly quotes: {
    readonly count: number
    readonly lowestSatang: string | null
    readonly highestSatang: string | null
    readonly selectedSatang: string | null
    readonly selectedIsLowest: boolean
    readonly nonLowestReason: string | null
  } | null
  readonly badge: CardBadge | null
}

const text = (s: bigint | null) => (s === null ? null : s.toString())

/**
 * The same reference read by the system for a card it sends to the request's own approver (BR-PRC-05), who may read it
 * (BR-PRC-07): no actor to check. null when the request is not there.
 */
export async function priceReferenceForCard(organizationId: string, requestId: string, now: Date): Promise<PriceReferenceDto | null> {
  return forTenant(organizationId).$transaction(async (tx) => {
    const facts = await priceRequestFacts(tx, requestId)
    return facts ? priceReferenceOf(tx, organizationId, facts, now) : null
  })
}

export async function priceReferenceOf(tx: TenantTx, organizationId: string, facts: PriceRequestFacts, now: Date): Promise<PriceReferenceDto> {
  const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } })
  const s6 = s6SettingsOf(org.settings)
  const alertPct = OrgSettingsSchema.shape.priceAlertPct.parse((org.settings as { priceAlertPct?: unknown } | null)?.priceAlertPct)
  const settings = { windowDays: s6.priceRefWindowDays, minSamples: s6.priceRefMinSamples, alertBp: Math.round(alertPct * PERCENT_TO_BP) }
  const samples = await priceSamples(tx, facts.lines, new Date(now.getTime() - settings.windowDays * MS_PER_DAY), now)
  const lines = facts.lines.map((l): PriceLineReferenceDto => {
    const key = lineKey(l)
    const r = priceReference(samples.get(key) ?? [], l.unitPriceSatang, facts.priceIncludesVat, now, settings)
    return {
      lineNo: l.lineNo,
      description: l.description,
      uom: l.uom,
      key,
      unitPriceSatang: l.unitPriceSatang.toString(),
      count: r.count,
      excludedVatIncluded: r.excludedVatIncluded,
      minSatang: text(r.min),
      medianSatang: text(r.median),
      maxSatang: text(r.max),
      lastSatang: text(r.last),
      status: r.status,
      deviationBp: r.deviationBp,
      alert: r.alert,
      agreement: l.agreement ? { supplierName: l.agreement.supplierName, unitPriceSatang: l.agreement.unitPriceSatang.toString() } : null,
    }
  })
  let quotes: PriceReferenceDto['quotes'] = null
  // The rate the request was sent with, or today's for a draft (BR-FORM-06)
  const rateBp = facts.quotations.length ? (facts.vatRateBp ?? (await todaysRate(now))) : null
  if (rateBp !== null) {
    const range = quoteRange(
      facts.quotations.map((q) => ({ ref: q.id, amountSatang: q.amountSatang, includesVat: q.includesVat })),
      facts.quotations.find((q) => q.isSelected)?.id ?? null,
      rateBp,
    )
    quotes = {
      count: range.count,
      lowestSatang: text(range.lowest),
      highestSatang: text(range.highest),
      selectedSatang: text(range.selected),
      selectedIsLowest: range.selectedIsLowest,
      nonLowestReason: range.selectedIsLowest ? null : facts.nonLowestQuoteReason,
    }
  }
  return { requestId: facts.id, ...settings, requestIncludesVat: facts.priceIncludesVat, lines, quotes, badge: cardBadge(lines) }
}

async function todaysRate(now: Date): Promise<number | null> {
  const rate = rateFor(taxDateOf(now), await listTaxRates())
  return rate.ok ? rate.rateBp : null
}
