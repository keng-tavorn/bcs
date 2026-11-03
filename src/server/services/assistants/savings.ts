import { createHash } from 'node:crypto'
import { lineKey } from '@/core/duplicates'
import { parseQuantity } from '@/core/money/math'
import { agreementDay } from '@/core/pricing/agreement'
import { formatQuantity } from '@/core/receiving'
import { err, ok, type Result } from '@/core/result'
import { findSavings, SAVINGS_KINDS, type OpenLine, type Opportunity, type Purchase, type SavingsAgreement, type SavingsKind } from '@/core/savings'
import { MS_PER_DAY } from '@/lib/constants'
import { loadPrincipal, scopesFor, type Principal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { priceRefSettingsOf } from '@/server/queries/price-reference'
import { freeLines } from '../procurement/pool'
import { AGREEMENT_DAYS } from './suggestions'

// The savings assistant (NEW-123 · FR-VIS-008 · ADR-081 · spec §7.21): what the organization's own data shows could be
// bought for less — a price above what was paid before, a catalogue line off its agreed price, one item several
// departments wait for in the pool, and agreed prices ending soon with what was bought at them. The amounts come from
// findSavings (src/core/savings), never from the AI, and nothing here changes a document or calls the AI.
// Who reads it: po.view and request.view of the whole organization (PROCUREMENT, FINANCE, EXECUTIVE, AUDITOR), because
// the history comes from every PO (BR-PRC-07 · OQ-116) and a group spans departments; anyone else is FORBIDDEN.

export { SAVINGS_KINDS, type SavingsKind } from '@/core/savings'

/** Rows of evidence an opportunity shows at most; the count says how many there are */
export const EVIDENCE_ROWS = 10

type Name = { readonly th: string; readonly en: string | null }

export interface SavingsRequestDto {
  readonly id: string
  readonly number: string
  readonly title: string
  readonly department: Name
  /** PENDING_APPROVAL: waiting for approval · POOL: approved, waiting for a PO */
  readonly stage: OpenLine['stage']
}

export interface SavingsLineDto {
  readonly request: SavingsRequestDto
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  /** Still to be ordered */
  readonly quantity: string
  readonly unitPriceSatang: string
  readonly supplier: Name | null
}

export interface SavingsPurchaseDto {
  readonly poId: string
  readonly poNumber: string
  readonly approvedAt: string
  readonly supplier: Name
  readonly quantity: string
  readonly unitPriceSatang: string
  readonly netSatang: string
}

export interface SavingsAgreementDto {
  readonly id: string
  readonly supplier: Name
  readonly unitPriceSatang: string
  readonly validFrom: string
  /** Not included (BR-PRC-06) */
  readonly validTo: string
}

export type SavingsItemDto =
  | {
      readonly kind: 'PRICE_ABOVE_HISTORY'
      readonly key: string
      readonly savingSatang: string
      readonly line: SavingsLineDto
      readonly referenceSatang: string
      readonly minSatang: string
      readonly maxSatang: string
      readonly deviationBp: number
      readonly count: number
      readonly purchases: readonly SavingsPurchaseDto[]
    }
  | {
      readonly kind: 'OFF_AGREEMENT'
      readonly key: string
      readonly savingSatang: string
      readonly line: SavingsLineDto
      readonly offAgreementReason: string | null
      readonly item: Name
      /** The lowest agreed price, which the saving is counted against */
      readonly agreedSatang: string
      readonly agreementId: string
      /** The item's agreed prices in effect today, the lowest first */
      readonly agreements: readonly SavingsAgreementDto[]
    }
  | {
      readonly kind: 'SAME_ITEM_DEPARTMENTS'
      readonly key: string
      readonly savingSatang: string
      readonly description: string
      readonly uom: string
      readonly site: Name | null
      readonly departments: number
      readonly lowestSatang: string
      readonly lines: ReadonlyArray<SavingsLineDto & { readonly savingSatang: string; readonly lowest: boolean }>
    }
  | {
      readonly kind: 'AGREEMENT_EXPIRING'
      readonly key: string
      readonly savingSatang: null
      readonly item: Name
      readonly agreement: SavingsAgreementDto
      readonly daysLeft: number
      readonly spentSatang: string
      readonly count: number
      readonly purchases: readonly SavingsPurchaseDto[]
    }

export interface SavingsDto {
  /** BR-SAV-06: each line once, its largest saving */
  readonly totalSatang: string
  readonly counts: Readonly<Record<SavingsKind, number>>
  readonly windowDays: number
  readonly agreementDays: number
  readonly items: readonly SavingsItemDto[]
}

/** Who reads the savings: every PO and every request of the organization (FR-VIS-008 AC2) */
export function readsSavings(principal: Principal): boolean {
  return principal.kind === 'member' && scopesFor(principal, 'po.view').has('ORG') && scopesFor(principal, 'request.view').has('ORG')
}

const nameOf = (r: { nameTh: string; nameEn?: string | null }): Name => ({ th: r.nameTh, en: r.nameEn ?? null })
const day = (d: Date) => d.toISOString().slice(0, 10)
const scaledText = (d: { toString(): string }) => parseQuantity(d.toString())
/** A group of lines named by its members, whatever order they came in */
const setKey = (ids: readonly string[]) => `${ids.length}:${createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 16)}`

export function savingsKeyOf(o: Opportunity): string {
  switch (o.kind) {
    case 'PRICE_ABOVE_HISTORY':
    case 'OFF_AGREEMENT':
      return `${o.kind}:${o.line}`
    case 'SAME_ITEM_DEPARTMENTS':
      return `${o.kind}:${setKey(o.lines.map((l) => l.ref))}`
    case 'AGREEMENT_EXPIRING':
      return `${o.kind}:${o.agreementId}`
  }
}

interface LineFacts {
  readonly open: OpenLine
  readonly dto: SavingsLineDto
  readonly offAgreementReason: string | null
  readonly catalogItemId: string | null
}

/** The request lines still to be ordered: of requests waiting for approval, and the pool's (freeLines, FR-P2P-001) */
async function openLines(tx: TenantTx): Promise<Map<string, LineFacts>> {
  const requestSelect = {
    id: true,
    number: true,
    title: true,
    chargedDepartmentId: true,
    deliverySiteId: true,
    suggestedSupplierId: true,
    priceIncludesVat: true,
    offAgreementReason: true,
    chargedDepartment: { select: { nameTh: true, nameEn: true } },
  } as const
  const lineSelect = { id: true, lineNo: true, description: true, uom: true, quantity: true, cancelledQuantity: true, unitPriceSatang: true, kind: true, catalogItemId: true, supplierId: true } as const
  const pending = await tx.request.findMany({ where: { documentType: 'PURCHASE_REQUEST', status: 'PENDING_APPROVAL' }, select: { ...requestSelect, lines: { orderBy: { lineNo: 'asc' }, select: lineSelect } } })
  const pool = await freeLines(tx)
  const poolRequests = new Map((await tx.request.findMany({ where: { id: { in: [...new Set(pool.map((l) => l.requestId))] } }, select: requestSelect })).map((r) => [r.id, r]))
  const poolLines = new Map((await tx.requestLine.findMany({ where: { id: { in: pool.map((l) => l.requestLineId) } }, select: { id: true, catalogItemId: true } })).map((l) => [l.id, l]))
  const supplierIds = [...new Set([...pending.flatMap((r) => [r.suggestedSupplierId, ...r.lines.map((l) => l.supplierId)]), ...pool.map((l) => l.supplierId), ...[...poolRequests.values()].map((r) => r.suggestedSupplierId)])].filter((id): id is string => Boolean(id))
  const suppliers = new Map((await tx.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, nameTh: true, nameEn: true } })).map((s) => [s.id, nameOf(s)]))

  const out = new Map<string, LineFacts>()
  const add = (
    r: { id: string; number: string | null; title: string; chargedDepartmentId: string; deliverySiteId: string | null; suggestedSupplierId: string | null; priceIncludesVat: boolean; offAgreementReason: string | null; chargedDepartment: { nameTh: string; nameEn: string | null } },
    stage: OpenLine['stage'],
    l: { id: string; lineNo: number; description: string; uom: string; kind: OpenLine['kind']; catalogItemId: string | null; supplierId: string | null; unitPriceSatang: bigint },
    quantity: string,
  ) => {
    if (!r.number) return
    const supplierId = l.supplierId ?? r.suggestedSupplierId
    out.set(l.id, {
      open: {
        ref: l.id,
        stage,
        key: lineKey(l),
        kind: l.kind,
        departmentId: r.chargedDepartmentId,
        siteId: r.deliverySiteId,
        catalogItemId: l.catalogItemId,
        supplierId,
        quantity,
        unitPriceSatang: l.unitPriceSatang,
        priceIncludesVat: r.priceIncludesVat,
      },
      dto: {
        request: { id: r.id, number: r.number, title: r.title, department: nameOf(r.chargedDepartment), stage },
        lineNo: l.lineNo,
        description: l.description,
        uom: l.uom,
        quantity,
        unitPriceSatang: l.unitPriceSatang.toString(),
        supplier: supplierId ? (suppliers.get(supplierId) ?? null) : null,
      },
      offAgreementReason: r.offAgreementReason,
      catalogItemId: l.catalogItemId,
    })
  }
  for (const r of pending) {
    for (const l of r.lines) {
      const left = scaledText(l.quantity) - scaledText(l.cancelledQuantity)
      if (left > 0n) add(r, 'PENDING_APPROVAL', l, formatQuantity(left))
    }
  }
  for (const f of pool) {
    const r = poolRequests.get(f.requestId)
    if (!r) continue
    add(r, 'POOL', { id: f.requestLineId, lineNo: f.lineNo, description: f.description, uom: f.uom, kind: f.kind, catalogItemId: poolLines.get(f.requestLineId)?.catalogItemId ?? null, supplierId: f.supplierId, unitPriceSatang: f.unitPriceSatang }, formatQuantity(f.free))
  }
  return out
}

/**
 * The lines of POs approved in the window (BR-PRC-01) that could bear on these lines and agreed prices: the same
 * description, a request line of the same catalogue item, or an agreed price among `agreementIds` — one bounded query
 * (NEW-38), keyed as BR-DUP-01 keys them (a PO line is a catalogue item when a request line it came from is one)
 */
async function purchasesIn(tx: TenantTx, lines: readonly LineFacts[], agreementIds: readonly string[], from: Date, to: Date) {
  const items = [...new Set(lines.map((l) => l.catalogItemId).filter((id): id is string => Boolean(id)))]
  const descriptions = [...new Set(lines.map((l) => l.dto.description))]
  const or = [
    ...(descriptions.length ? [{ description: { in: descriptions } }] : []),
    ...(items.length ? [{ sources: { some: { requestLine: { catalogItemId: { in: items } } } } }] : []),
    ...(agreementIds.length ? [{ sources: { some: { requestLine: { priceAgreementId: { in: [...agreementIds] } } } } }] : []),
  ]
  if (or.length === 0) return []
  return tx.poLine.findMany({
    where: { po: { approvedAt: { gte: from, lt: to }, status: { notIn: ['REJECTED', 'CANCELLED', 'DRAFT', 'PENDING_APPROVAL'] } }, OR: or },
    orderBy: [{ po: { approvedAt: 'asc' } }, { id: 'asc' }],
    select: {
      id: true,
      description: true,
      uom: true,
      quantity: true,
      unitPriceSatang: true,
      netSatang: true,
      po: { select: { id: true, number: true, approvedAt: true, priceIncludesVat: true, supplier: { select: { nameTh: true, nameEn: true } } } },
      sources: { select: { requestLine: { select: { catalogItemId: true, priceAgreementId: true } } } },
    },
  })
}

/** Every saving of the organization for a member who reads every PO and request (FR-VIS-008) */
export async function savingsOpportunities(ctx: Ctx): Promise<Result<SavingsDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'the savings are a member’s page')
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const principal = await loadPrincipal(tx, ctx)
    if (!readsSavings(principal)) return err('FORBIDDEN', 'missing capability po.view or request.view of the organization', { capability: 'po.view' })
    const org = await tx.organization.findUniqueOrThrow({ where: { id: ctx.organizationId }, select: { settings: true } })
    const ref = priceRefSettingsOf(org.settings)
    const today = agreementDay(ctx.now)
    const todayDate = new Date(`${today}T00:00:00Z`)

    const lines = await openLines(tx)
    // In effect today, ending later, or starting later (a continuation, BR-SAV-04)
    const agreementRows = await tx.priceAgreement.findMany({
      where: { validTo: { gt: todayDate } },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      select: { id: true, catalogItemId: true, supplierId: true, unitPriceSatang: true, validFrom: true, validTo: true, endedAt: true, catalogItem: { select: { nameTh: true, nameEn: true } }, supplier: { select: { nameTh: true, nameEn: true } } },
    })
    const agreements: SavingsAgreement[] = agreementRows.map((a) => ({ id: a.id, catalogItemId: a.catalogItemId, supplierId: a.supplierId, unitPriceSatang: a.unitPriceSatang, validFrom: day(a.validFrom), validTo: day(a.validTo), ended: a.endedAt !== null }))
    const rows = await purchasesIn(tx, [...lines.values()], agreementRows.map((a) => a.id), new Date(ctx.now.getTime() - ref.windowDays * MS_PER_DAY), ctx.now)
    const purchases: Purchase[] = rows.flatMap((r) => {
      if (!r.po.approvedAt) return []
      const catalogItemId = r.sources.map((s) => s.requestLine.catalogItemId).find((id): id is string => Boolean(id)) ?? null
      const agreementIds = [...new Set(r.sources.map((s) => s.requestLine.priceAgreementId).filter((id): id is string => Boolean(id)))]
      return [{ ref: r.id, key: lineKey({ catalogItemId, description: r.description, uom: r.uom }), approvedAt: r.po.approvedAt, unitPriceSatang: r.unitPriceSatang, priceIncludesVat: r.po.priceIncludesVat, netSatang: r.netSatang, agreementIds }]
    })

    const found = findSavings({ lines: [...lines.values()].map((l) => l.open), purchases, agreements }, { ...ref, at: ctx.now, today, agreementDays: AGREEMENT_DAYS })

    const purchaseRows = new Map(
      rows.map((r) => [
        r.id,
        { poId: r.po.id, poNumber: r.po.number ?? '', approvedAt: r.po.approvedAt?.toISOString() ?? '', supplier: nameOf(r.po.supplier), quantity: formatQuantity(scaledText(r.quantity)), unitPriceSatang: r.unitPriceSatang.toString(), netSatang: r.netSatang.toString() } satisfies SavingsPurchaseDto,
      ]),
    )
    const agreementById = new Map(agreementRows.map((a) => [a.id, a]))
    const agreementDto = (id: string): SavingsAgreementDto => {
      const a = agreementById.get(id)!
      return { id: a.id, supplier: nameOf(a.supplier), unitPriceSatang: a.unitPriceSatang.toString(), validFrom: day(a.validFrom), validTo: day(a.validTo) }
    }
    const siteIds = [...new Set(found.opportunities.flatMap((o) => (o.kind === 'SAME_ITEM_DEPARTMENTS' ? [lines.get(o.lowestLine)!.open.siteId] : [])).filter((id): id is string => Boolean(id)))]
    const sites = new Map((await tx.deliverySite.findMany({ where: { id: { in: siteIds } }, select: { id: true, nameTh: true } })).map((s) => [s.id, nameOf(s)]))
    const evidence = (refs: readonly string[]) => refs.slice(0, EVIDENCE_ROWS).map((r) => purchaseRows.get(r)!)

    const items = found.opportunities.map((o): SavingsItemDto => {
      const key = savingsKeyOf(o)
      switch (o.kind) {
        case 'PRICE_ABOVE_HISTORY':
          return {
            kind: o.kind,
            key,
            savingSatang: o.savingSatang.toString(),
            line: lines.get(o.line)!.dto,
            referenceSatang: o.referenceSatang.toString(),
            minSatang: o.minSatang.toString(),
            maxSatang: o.maxSatang.toString(),
            deviationBp: o.deviationBp,
            count: o.count,
            purchases: evidence(o.purchases),
          }
        case 'OFF_AGREEMENT': {
          const line = lines.get(o.line)!
          const agreed = agreementById.get(o.agreementId)!
          const inEffect = agreements
            .filter((a) => a.catalogItemId === agreed.catalogItemId && a.validFrom <= today && today < a.validTo)
            .sort((a, b) => (a.unitPriceSatang < b.unitPriceSatang ? -1 : a.unitPriceSatang > b.unitPriceSatang ? 1 : a.id < b.id ? -1 : 1))
          return {
            kind: o.kind,
            key,
            savingSatang: o.savingSatang.toString(),
            line: line.dto,
            offAgreementReason: line.offAgreementReason,
            item: nameOf(agreed.catalogItem),
            agreedSatang: o.agreedSatang.toString(),
            agreementId: o.agreementId,
            agreements: inEffect.map((a) => agreementDto(a.id)),
          }
        }
        case 'SAME_ITEM_DEPARTMENTS': {
          const first = lines.get(o.lowestLine)!
          return {
            kind: o.kind,
            key,
            savingSatang: o.savingSatang.toString(),
            description: first.dto.description,
            uom: first.dto.uom,
            site: first.open.siteId ? (sites.get(first.open.siteId) ?? null) : null,
            departments: o.departments,
            lowestSatang: o.lowestSatang.toString(),
            lines: o.lines.map((l) => ({ ...lines.get(l.ref)!.dto, savingSatang: l.savingSatang.toString(), lowest: l.ref === o.lowestLine })),
          }
        }
        case 'AGREEMENT_EXPIRING': {
          const a = agreementById.get(o.agreementId)!
          return {
            kind: o.kind,
            key,
            savingSatang: null,
            item: nameOf(a.catalogItem),
            agreement: agreementDto(a.id),
            daysLeft: o.daysLeft,
            spentSatang: o.spentSatang.toString(),
            count: o.purchases.length,
            purchases: evidence(o.purchases),
          }
        }
      }
    })
    const counts = Object.fromEntries(SAVINGS_KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])) as Record<SavingsKind, number>
    return ok({ totalSatang: found.totalSatang.toString(), counts, windowDays: ref.windowDays, agreementDays: AGREEMENT_DAYS, items })
  })
}
