import { g9Rate, type G9Rate, type RiskTierCode } from '@/core/risk'
import { addBusinessMinutes, type BusinessCalendar } from '@/core/sla'
import { businessDayMinutes } from '@/core/supplier-onboarding'
import { dateIn } from '@/core/supplier-docs'
import type { TenantTx } from '@/server/db/tenant'

// KPI G-9 and the risk report of /reports/risk (S11-11 · BR-RSK-15 · FR-RSK-204 AC2 · §11.4): of the suppliers whose
// first PO (by submittedAt, a cancelled PO not counted) was sent in the period and met the gate at tier HIGH, the share
// that passed with a COMPLETED assessment (an override counts below the line only · g9Rate). The gate of that PO is the
// one of its first po.risk_gate_passed event of trigger SUBMIT, else PurchaseOrder.riskGate. With it, as of now: the
// suppliers by tier ("never assessed" apart from LOW), the assessments open past applicationEscalateBusinessDays of S7,
// the suppliers past their cycle (OVERDUE), the overrides open, expired and used, and the suppliers with a registry flag.
// The numbers come from this code, never from the AI. Read only, inside the caller's transaction (the report checks
// report.view and its scope first): `departmentIds` narrows every part to the suppliers that departments have a PO with.

const OPEN_ASSESSMENT = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const
const TIERS: readonly RiskTierCode[] = ['HIGH', 'MEDIUM', 'LOW']
const TIMEZONE = 'Asia/Bangkok'
const nameOf = (s: { readonly nameTh: string }) => s.nameTh
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

interface GateRead {
  readonly tier: RiskTierCode
  readonly source: 'NOT_REQUIRED' | 'ASSESSMENT' | 'OVERRIDE'
}
const gateOf = (value: unknown): GateRead | null => {
  if (!value || typeof value !== 'object') return null
  const g = value as { tier?: unknown; source?: unknown }
  return typeof g.tier === 'string' && typeof g.source === 'string' ? { tier: g.tier as RiskTierCode, source: g.source as GateRead['source'] } : null
}

export interface RiskKpiFirstPo {
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: string
  readonly poId: string
  readonly poNumber: string | null
  readonly submittedAt: string
  readonly tier: RiskTierCode
  readonly source: GateRead['source']
}

export interface RiskKpi {
  /** G-9 and the HIGH suppliers it counts, in the order of their first PO */
  readonly g9: G9Rate & { readonly rows: readonly RiskKpiFirstPo[] }
  /** Active suppliers by tier, HIGH first; tier null = never assessed (not LOW) */
  readonly tiers: readonly { readonly tier: RiskTierCode | null; readonly suppliers: number }[]
  readonly pending: readonly { readonly assessmentId: string; readonly number: string | null; readonly status: string; readonly supplierId: string; readonly supplierName: string; readonly openedAt: string; readonly escalatedAt: string }[]
  readonly overdue: readonly { readonly supplierId: string; readonly code: string; readonly name: string; readonly tier: RiskTierCode | null; readonly validUntil: string | null }[]
  readonly overrides: {
    readonly open: number
    readonly expired: number
    readonly used: number
    readonly rows: readonly { readonly id: string; readonly number: string | null; readonly status: 'OPEN' | 'EXPIRED'; readonly supplierName: string; readonly requestedBy: string; readonly expiresOn: string; readonly usedCount: number; readonly usedGrossSatang: bigint; readonly capGrossSatang: bigint }[]
  }
  readonly flagged: readonly { readonly supplierId: string; readonly code: string; readonly name: string; readonly registryFlag: string; readonly flaggedAt: string | null }[]
}

export interface RiskKpiInput {
  readonly from: Date
  readonly to: Date
  readonly now: Date
  readonly calendar: BusinessCalendar
  /** supplier.applicationEscalateBusinessDays of S7: an assessment open longer is "pending" (BR-RSK-15) */
  readonly escalateBusinessDays: number
}

/** The suppliers the departments have a PO with (any status but a draft): the scope of a head's report */
async function suppliersOfDepartments(tx: TenantTx, departmentIds: readonly string[]): Promise<string[]> {
  const pos = await tx.purchaseOrder.findMany({
    where: { status: { not: 'DRAFT' }, lines: { some: { budgetLine: { departmentId: { in: [...departmentIds] } } } } },
    select: { supplierId: true },
    distinct: ['supplierId'],
  })
  return pos.map((p) => p.supplierId)
}

/** The risk report for the period [from, to); `departmentIds` null for the whole organization */
export async function computeRiskKpi(tx: TenantTx, input: RiskKpiInput, departmentIds: readonly string[] | null): Promise<RiskKpi> {
  const scoped = departmentIds ? await suppliersOfDepartments(tx, departmentIds) : null
  const inScope = scoped ? { supplierId: { in: scoped } } : {}
  const supplierInScope = scoped ? { id: { in: scoped } } : {}

  // ---------- G-9: the first PO of each supplier, sent in the period ----------
  const sent = await tx.purchaseOrder.findMany({
    where: { status: { not: 'CANCELLED' }, submittedAt: { gte: input.from, lt: input.to }, ...inScope },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    select: { id: true, number: true, supplierId: true, submittedAt: true, riskGate: true, supplier: { select: { code: true, nameTh: true } } },
  })
  const candidates = [...new Set(sent.map((p) => p.supplierId))]
  const earlier = candidates.length
    ? await tx.purchaseOrder.findMany({ where: { supplierId: { in: candidates }, status: { not: 'CANCELLED' }, submittedAt: { lt: input.from } }, select: { supplierId: true }, distinct: ['supplierId'] })
    : []
  const before = new Set(earlier.map((p) => p.supplierId))
  const firsts = new Map<string, (typeof sent)[number]>()
  for (const p of sent) if (!before.has(p.supplierId) && !firsts.has(p.supplierId)) firsts.set(p.supplierId, p)
  const firstPos = [...firsts.values()]
  const events = firstPos.length
    ? await tx.event.findMany({ where: { type: 'po.risk_gate_passed', aggregateType: 'PurchaseOrder', aggregateId: { in: firstPos.map((p) => p.id) } }, orderBy: { seq: 'asc' }, select: { aggregateId: true, data: true } })
    : []
  const atSubmit = new Map<string, GateRead>()
  for (const e of events) {
    const data = e.data as { trigger?: unknown } | null
    const gate = gateOf(e.data)
    if (gate && data?.trigger === 'SUBMIT' && !atSubmit.has(e.aggregateId)) atSubmit.set(e.aggregateId, gate)
  }
  const gated = firstPos.flatMap((p) => {
    const gate = atSubmit.get(p.id) ?? gateOf(p.riskGate)
    return gate ? [{ p, gate }] : []
  })
  const rate = g9Rate(gated.map(({ gate }) => ({ high: gate.tier === 'HIGH', assessed: gate.source === 'ASSESSMENT' })))
  const g9Rows: RiskKpiFirstPo[] = gated
    .filter(({ gate }) => gate.tier === 'HIGH')
    .map(({ p, gate }) => ({ supplierId: p.supplierId, supplierCode: p.supplier.code, supplierName: nameOf(p.supplier), poId: p.id, poNumber: p.number, submittedAt: p.submittedAt!.toISOString(), tier: gate.tier, source: gate.source }))

  // ---------- as of now ----------
  const byTier = await tx.supplier.groupBy({ by: ['riskTier'], where: { status: 'ACTIVE', ...supplierInScope }, _count: { _all: true } })
  const countOf = (tier: RiskTierCode | null) => byTier.find((b) => b.riskTier === tier)?._count._all ?? 0
  const tiers = [...TIERS.map((tier) => ({ tier, suppliers: countOf(tier) })), { tier: null, suppliers: countOf(null) }]

  const day = businessDayMinutes(input.calendar)
  const open = await tx.riskAssessment.findMany({
    where: { status: { in: [...OPEN_ASSESSMENT] }, ...inScope },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, number: true, status: true, createdAt: true, supplierId: true, supplier: { select: { code: true, nameTh: true } } },
  })
  const pending = open.flatMap((a) => {
    const escalatedAt = addBusinessMinutes(a.createdAt, input.escalateBusinessDays * day, input.calendar)
    return escalatedAt <= input.now ? [{ assessmentId: a.id, number: a.number, status: a.status, supplierId: a.supplierId, supplierName: nameOf(a.supplier), openedAt: a.createdAt.toISOString(), escalatedAt: escalatedAt.toISOString() }] : []
  })

  const overdue = await tx.supplier.findMany({
    where: { status: 'ACTIVE', riskStatus: 'OVERDUE', ...supplierInScope },
    orderBy: [{ riskValidUntil: 'asc' }, { code: 'asc' }],
    select: { id: true, code: true, nameTh: true, riskTier: true, riskValidUntil: true },
  })

  // an override is open while APPROVED and on or before its last day; past it (EXPIRED, or APPROVED the job has not
  // closed yet) it is expired; used = it let out at least one PO (BR-RSK-10)
  const today = new Date(`${dateIn(input.now, TIMEZONE)}T00:00:00Z`)
  const overrides = await tx.riskOverride.findMany({
    where: { status: { in: ['APPROVED', 'EXPIRED'] }, ...inScope },
    orderBy: [{ expiresOn: 'desc' }, { id: 'asc' }],
    select: { id: true, number: true, status: true, expiresOn: true, usedCount: true, usedGrossSatang: true, capGrossSatang: true, requestedById: true, supplier: { select: { code: true, nameTh: true } } },
  })
  const requesters = await tx.member.findMany({ where: { id: { in: [...new Set(overrides.map((o) => o.requestedById))] } }, select: { id: true, displayNameTh: true } })
  const overrideRows = overrides.map((o) => ({
    id: o.id,
    number: o.number,
    status: o.status === 'APPROVED' && o.expiresOn >= today ? ('OPEN' as const) : ('EXPIRED' as const),
    supplierName: nameOf(o.supplier),
    requestedBy: requesters.find((m) => m.id === o.requestedById)?.displayNameTh ?? '',
    expiresOn: iso(o.expiresOn)!,
    usedCount: o.usedCount,
    usedGrossSatang: o.usedGrossSatang,
    capGrossSatang: o.capGrossSatang,
  }))

  const flagged = await tx.supplier.findMany({
    where: { status: 'ACTIVE', registryFlag: { not: 'NONE' }, ...supplierInScope },
    orderBy: [{ registryFlaggedAt: 'desc' }, { code: 'asc' }],
    select: { id: true, code: true, nameTh: true, registryFlag: true, registryFlaggedAt: true },
  })

  return {
    g9: { ...rate, rows: g9Rows },
    tiers,
    pending,
    overdue: overdue.map((s) => ({ supplierId: s.id, code: s.code, name: nameOf(s), tier: s.riskTier, validUntil: iso(s.riskValidUntil) })),
    overrides: {
      open: overrideRows.filter((o) => o.status === 'OPEN').length,
      expired: overrideRows.filter((o) => o.status === 'EXPIRED').length,
      used: overrideRows.filter((o) => o.usedCount > 0).length,
      rows: overrideRows,
    },
    flagged: flagged.map((s) => ({ supplierId: s.id, code: s.code, name: nameOf(s), registryFlag: s.registryFlag, flaggedAt: s.registryFlaggedAt?.toISOString() ?? null })),
  }
}
