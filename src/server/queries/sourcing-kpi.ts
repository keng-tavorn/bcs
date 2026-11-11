import type { Satang } from '@/core/money/math'
import { lineNet } from '@/core/money/math'
import type { BusinessCalendar } from '@/core/sla'
import { cycleDaysTenths, formatTenths, quotationShare, savings, savingsTotal, type BaselinePart } from '@/core/sourcing'
import { dateIn } from '@/core/supplier-docs'
import { lowerMedian } from '@/core/workflow-reports'
import type { TenantTx } from '@/server/db/tenant'

// KPI G-8 of sourcing and the report of /reports/sourcing (S10-15 · BR-RFX-15 · §11.4 G-8): the awards approved in the
// period (by decidedAt), each with its saving against the requests its lines came from — the selected quotation of a
// request (BR-FORM-06, shared by the quantity brought in), else the requester's estimate of the line, a need's reference
// price — labelled QUOTATION, ESTIMATE or MIXED, and its business days from opening the RFx to approving the award; the
// totals of the period and of each quarter, by kind of baseline; the lower median of the days; the RFx open now. A saving
// may be negative. An award of a cancelled or concluded RFx, rejected or cancelled, is not counted (only APPROVED ones of
// an AWARDED RFx are). The numbers come from this code, never from the AI (P-8). Read only, inside the caller's
// transaction (the report checks report.view, its scope and the module first).

const TIMEZONE = 'Asia/Bangkok'
const KINDS = ['QUOTATION', 'ESTIMATE', 'MIXED'] as const
export type SavingKind = (typeof KINDS)[number]
const OPEN_STATUSES = ['OPEN', 'CLOSED', 'EVALUATING'] as const
const OPEN_MAX = 100
// every baseline part here is before VAT already (RequestQuotation.netSatang of BR-FORM-06), so no rate is applied
const NET_ONLY = 0

export interface SavingTotal {
  readonly awards: number
  readonly baselineNet: Satang
  readonly savings: Satang
  readonly savingsBp: number | null
}

export interface SourcingAwardRow {
  readonly awardId: string
  readonly awardNumber: string | null
  readonly rfxEventId: string
  readonly rfxNumber: string | null
  readonly rfxTitle: string
  readonly rfxKind: string
  /** The winners by code and name (a supplier that is a person: its code only · NFR-PRIV-02) */
  readonly winners: readonly string[]
  readonly openedAt: string
  readonly decidedAt: string
  /** "2026-Q4" by the Thai date of the approval */
  readonly quarter: string
  readonly awardedNet: Satang
  /** null when a line has no baseline (a need without a reference price): the award is left out of the savings */
  readonly baselineNet: Satang | null
  readonly baselineKind: SavingKind | null
  readonly savings: Satang | null
  readonly savingsBp: number | null
  readonly businessDays: string
}

export interface SourcingKpi {
  readonly total: SavingTotal & { readonly byKind: Readonly<Record<SavingKind, SavingTotal>> }
  readonly quarters: ReadonlyArray<SavingTotal & { readonly quarter: string; readonly byKind: Readonly<Record<SavingKind, SavingTotal>> }>
  /** The lower median of the business days from opening to the award's approval, one decimal; null without an award */
  readonly medianDays: string | null
  readonly awards: readonly SourcingAwardRow[]
  /** Awards without a baseline, counted in the days but not in the savings */
  readonly withoutBaseline: number
  readonly open: ReadonlyArray<{ readonly rfxEventId: string; readonly number: string | null; readonly title: string; readonly kind: string; readonly status: string; readonly closesAt: string | null; readonly invited: number; readonly bids: number }>
}

/** "2026-10-26" → "2026-Q4" */
export const quarterOf = (day: string): string => `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`

function totalOf(items: readonly SourcingAwardRow[]): SavingTotal {
  const counted = items.filter((r): r is SourcingAwardRow & { baselineNet: Satang; savings: Satang } => r.baselineNet !== null && r.savings !== null)
  return { awards: counted.length, ...savingsTotal(counted.map((r) => ({ baselineNet: r.baselineNet, savings: r.savings }))) }
}

function withKinds(items: readonly SourcingAwardRow[]): SavingTotal & { readonly byKind: Record<SavingKind, SavingTotal> } {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, totalOf(items.filter((r) => r.baselineKind === k))])) as Record<SavingKind, SavingTotal>
  return { ...totalOf(items), byKind }
}

/**
 * The sourcing report of a period [from, to) on the organization's business calendar; `departmentIds` narrows it to the
 * RFx of those departments — the department of the award's route or one of the source lines' (report.view DEPT) — null
 * for the whole organization.
 */
export async function computeSourcingKpi(tx: TenantTx, calendar: BusinessCalendar, period: { readonly from: Date; readonly to: Date }, departmentIds: readonly string[] | null): Promise<SourcingKpi> {
  const inScope = departmentIds ? { OR: [{ requestingDepartmentId: { in: [...departmentIds] } }, { sourceDepartmentIds: { hasSome: [...departmentIds] } }] } : {}
  const decided = await tx.awardDecision.findMany({
    where: { status: 'APPROVED', decidedAt: { gte: period.from, lt: period.to }, rfxEvent: { status: 'AWARDED', openedAt: { not: null }, ...inScope } },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      number: true,
      netSatang: true,
      decidedAt: true,
      rfxEvent: { select: { id: true, number: true, title: true, kind: true, openedAt: true, sourceKind: true } },
      lines: {
        orderBy: { rfxLine: { lineNo: 'asc' } },
        select: {
          quantity: true,
          supplier: { select: { code: true, nameTh: true, payeeType: true } },
          rfxLine: {
            select: {
              refUnitPriceSatang: true,
              // every source of the line, also the ones released at the approval (active = false · INV-RFX-03)
              sources: { orderBy: { createdAt: 'asc' }, select: { quantity: true, requestLine: { select: { id: true, quantity: true, unitPriceSatang: true, requestId: true } } } },
            },
          },
        },
      },
    },
  })

  // the selected quotation and the lines of every source request (BR-FORM-06: the quotation is the request's)
  const requestIds = [...new Set(decided.flatMap((a) => a.lines.flatMap((l) => l.rfxLine.sources.map((s) => s.requestLine.requestId))))]
  const [quotations, requestLines] = requestIds.length
    ? await Promise.all([
        tx.requestQuotation.findMany({ where: { requestId: { in: requestIds }, isSelected: true }, select: { requestId: true, netSatang: true } }),
        tx.requestLine.findMany({ where: { requestId: { in: requestIds } }, orderBy: [{ requestId: 'asc' }, { lineNo: 'asc' }], select: { id: true, requestId: true, netSatang: true } }),
      ])
    : [[], []]
  const quotationOf = new Map(quotations.map((q) => [q.requestId, q.netSatang]))
  const linesOf = new Map<string, Array<{ id: string; netSatang: Satang }>>()
  for (const l of requestLines) linesOf.set(l.requestId, [...(linesOf.get(l.requestId) ?? []), l])

  const awards: SourcingAwardRow[] = []
  for (const a of decided) {
    const decidedAt = a.decidedAt!
    const openedAt = a.rfxEvent.openedAt!
    let parts: BaselinePart[] | null = []
    for (const line of a.lines) {
      if (a.rfxEvent.sourceKind === 'NEED' || line.rfxLine.sources.length === 0) {
        // a need: its reference price × the quantity awarded (the requester's side has no price)
        if (line.rfxLine.refUnitPriceSatang === null) {
          parts = null
          break
        }
        parts.push({ kind: 'ESTIMATE', netSatang: lineNet(line.quantity.toString(), line.rfxLine.refUnitPriceSatang) })
        continue
      }
      for (const s of line.rfxLine.sources) {
        const quoted = quotationOf.get(s.requestLine.requestId)
        if (quoted !== undefined) {
          const siblings = linesOf.get(s.requestLine.requestId) ?? []
          const index = siblings.findIndex((x) => x.id === s.requestLine.id)
          parts.push({ kind: 'QUOTATION', netSatang: quotationShare(quoted, siblings.map((x) => x.netSatang), index, s.quantity.toString(), s.requestLine.quantity.toString()) })
        } else parts.push({ kind: 'ESTIMATE', netSatang: lineNet(s.quantity.toString(), s.requestLine.unitPriceSatang) })
      }
    }
    const saving = parts && parts.length ? savings(parts, a.netSatang, NET_ONLY) : null
    const winners = [...new Map(a.lines.map((l) => [l.supplier.code, l.supplier.payeeType === 'INDIVIDUAL' ? l.supplier.code : `${l.supplier.code} ${l.supplier.nameTh}`])).values()]
    awards.push({
      awardId: a.id,
      awardNumber: a.number,
      rfxEventId: a.rfxEvent.id,
      rfxNumber: a.rfxEvent.number,
      rfxTitle: a.rfxEvent.title,
      rfxKind: a.rfxEvent.kind,
      winners,
      openedAt: openedAt.toISOString(),
      decidedAt: decidedAt.toISOString(),
      quarter: quarterOf(dateIn(decidedAt, TIMEZONE)),
      awardedNet: a.netSatang,
      baselineNet: saving?.baselineNet ?? null,
      baselineKind: saving?.baselineKind ?? null,
      savings: saving?.savings ?? null,
      savingsBp: saving?.savingsBp ?? null,
      businessDays: formatTenths(cycleDaysTenths(openedAt, decidedAt, calendar)),
    })
  }

  const tenths = decided.map((a) => cycleDaysTenths(a.rfxEvent.openedAt!, a.decidedAt!, calendar))
  const median = lowerMedian(tenths)
  const quarters = [...new Set(awards.map((r) => r.quarter))].sort().map((quarter) => ({ quarter, ...withKinds(awards.filter((r) => r.quarter === quarter)) }))

  const open = await tx.rfxEvent.findMany({
    where: { status: { in: [...OPEN_STATUSES] }, ...inScope },
    orderBy: [{ closesAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
    take: OPEN_MAX,
    select: { id: true, number: true, title: true, kind: true, status: true, closesAt: true, _count: { select: { invites: { where: { status: { not: 'REMOVED' } } }, bids: { where: { status: 'SUBMITTED' } } } } },
  })

  return {
    total: withKinds(awards),
    quarters,
    medianDays: median === null ? null : formatTenths(median),
    awards,
    withoutBaseline: awards.filter((r) => r.baselineNet === null).length,
    open: open.map((o) => ({ rfxEventId: o.id, number: o.number, title: o.title, kind: o.kind, status: o.status, closesAt: o.closesAt?.toISOString() ?? null, invited: o._count.invites, bids: o._count.bids })),
  }
}
