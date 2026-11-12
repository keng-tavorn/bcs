import type { Result } from '@/core/result'
import { addCalendarDays, type RiskDomain, type RiskTierCode } from '@/core/risk'
import { dateIn } from '@/core/supplier-docs'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import type { SupplierRiskStatusCode } from '@/server/queries/risk'
import { requireModule } from '../modules'
import { OVERRIDE_EXPIRY_NOTICE_DAYS } from './schedule'
import { RISK_TIMEZONE } from './screening'

// /risk (S11-10 · docs/sub-specs/S11.md "หน้าจอ" · BR-RSK-14): what needs attention in the organization's supplier risk —
// the suppliers whose assessment is about to run out, has run out or must be done again (or any tier and status the
// reader filters for), the assessments still being answered or reviewed, the reviewers' slots still open, and the
// overrides being asked for or running out within OVERRIDE_EXPIRY_NOTICE_DAYS, and the reassessments still open. Read with risk.assessment.view
// (PROCUREMENT FINANCE EXECUTIVE AUDITOR). Read only.

export const RISK_OVERVIEW_LIMIT = 200
export const ATTENTION_STATUSES: readonly SupplierRiskStatusCode[] = ['EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED']
const STATUSES: readonly SupplierRiskStatusCode[] = ['NOT_ASSESSED', 'IN_PROGRESS', 'CURRENT', 'EXPIRING', 'OVERDUE', 'REASSESS_REQUIRED']
const TIERS: readonly RiskTierCode[] = ['LOW', 'MEDIUM', 'HIGH']

export interface RiskOverviewFilter {
  readonly tier?: string
  readonly status?: string
}

export interface RiskOverview {
  readonly filter: { readonly tier: RiskTierCode | null; readonly status: SupplierRiskStatusCode | null }
  readonly suppliers: readonly { readonly id: string; readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly tier: RiskTierCode | null; readonly status: SupplierRiskStatusCode; readonly validUntil: string | null }[]
  readonly openAssessments: readonly { readonly id: string; readonly number: string | null; readonly status: string; readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string }; readonly inherentTier: RiskTierCode; readonly lastActivityAt: Date }[]
  readonly openSlots: readonly { readonly assessmentId: string; readonly assessmentNumber: string | null; readonly supplierName: string; readonly riskDomains: readonly RiskDomain[]; readonly reviewerName: string; readonly since: Date }[]
  readonly overrides: readonly { readonly id: string; readonly number: string | null; readonly status: string; readonly supplierName: string; readonly expiresOn: string; readonly expiringSoon: boolean }[]
  /** The reassessments still open: by cycle, an expired override, a registry flag (scene 18) */
  readonly openReviews: readonly { readonly id: string; readonly supplier: { readonly id: string; readonly code: string; readonly nameTh: string }; readonly reason: string; readonly tier: RiskTierCode | null; readonly dueAt: Date; readonly registryFlag: string | null }[]
  readonly counts: { readonly suppliers: number; readonly openAssessments: number; readonly openSlots: number; readonly overrides: number; readonly openReviews: number }
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

export async function riskOverview(ctx: Ctx, filter: RiskOverviewFilter = {}): Promise<Result<RiskOverview>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return on
    const may = await authorize(tx, ctx, 'risk.assessment.view')
    if (!may.ok) return may
    const tier = TIERS.find((t) => t === filter.tier) ?? null
    const status = STATUSES.find((s) => s === filter.status) ?? null
    const today = dateIn(ctx.now, RISK_TIMEZONE)

    // with no filter: the suppliers that need attention; a filter shows every supplier that matches it
    const supplierWhere = { status: 'ACTIVE' as const, ...(tier ? { riskTier: tier } : {}), riskStatus: status ? status : tier ? undefined : { in: [...ATTENTION_STATUSES] } }
    const [suppliers, supplierCount] = [
      await tx.supplier.findMany({ where: supplierWhere, orderBy: [{ riskValidUntil: 'asc' }, { code: 'asc' }], take: RISK_OVERVIEW_LIMIT, select: { id: true, code: true, nameTh: true, nameEn: true, riskTier: true, riskStatus: true, riskValidUntil: true } }),
      await tx.supplier.count({ where: supplierWhere }),
    ]
    const openWhere = { status: { in: ['DRAFT' as const, 'IN_REVIEW' as const, 'RETURNED' as const] } }
    const [assessments, assessmentCount] = [
      await tx.riskAssessment.findMany({ where: openWhere, orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }], take: RISK_OVERVIEW_LIMIT, select: { id: true, number: true, status: true, inherentTier: true, lastActivityAt: true, supplier: { select: { id: true, code: true, nameTh: true } } } }),
      await tx.riskAssessment.count({ where: openWhere }),
    ]
    const slotWhere = { status: 'OPEN' as const }
    const [slots, slotCount] = [
      await tx.reviewTask.findMany({ where: slotWhere, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: RISK_OVERVIEW_LIMIT, select: { assessmentId: true, riskDomains: true, assigneeMemberId: true, createdAt: true, assessment: { select: { number: true, supplier: { select: { nameTh: true } } } } } }),
      await tx.reviewTask.count({ where: slotWhere }),
    ]
    const soon = new Date(`${addCalendarDays(today, OVERRIDE_EXPIRY_NOTICE_DAYS)}T00:00:00Z`)
    const overrideWhere = { OR: [{ status: { in: ['DRAFT' as const, 'PENDING_APPROVAL' as const, 'RETURNED' as const] } }, { status: 'APPROVED' as const, expiresOn: { lte: soon } }] }
    const [overrides, overrideCount] = [
      await tx.riskOverride.findMany({ where: overrideWhere, orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }], take: RISK_OVERVIEW_LIMIT, select: { id: true, number: true, status: true, expiresOn: true, supplier: { select: { nameTh: true } } } }),
      await tx.riskOverride.count({ where: overrideWhere }),
    ]
    const reviewWhere = { status: 'OPEN' as const }
    const [openReviews, reviewCount] = [
      await tx.riskReview.findMany({ where: reviewWhere, orderBy: [{ dueAt: 'asc' }, { id: 'asc' }], take: RISK_OVERVIEW_LIMIT, select: { id: true, reason: true, tier: true, dueAt: true, registryFlag: true, supplier: { select: { id: true, code: true, nameTh: true } } } }),
      await tx.riskReview.count({ where: reviewWhere }),
    ]
    const reviewers = await tx.member.findMany({ where: { id: { in: [...new Set(slots.map((x) => x.assigneeMemberId))] } }, select: { id: true, displayNameTh: true } })

    return {
      ok: true as const,
      data: {
        filter: { tier, status },
        suppliers: suppliers.map((s) => ({ id: s.id, code: s.code, nameTh: s.nameTh, nameEn: s.nameEn, tier: s.riskTier, status: s.riskStatus, validUntil: iso(s.riskValidUntil) })),
        openAssessments: assessments.map((a) => ({ id: a.id, number: a.number, status: a.status, supplier: a.supplier, inherentTier: a.inherentTier, lastActivityAt: a.lastActivityAt })),
        openSlots: slots.map((x) => ({ assessmentId: x.assessmentId, assessmentNumber: x.assessment.number, supplierName: x.assessment.supplier.nameTh, riskDomains: x.riskDomains as RiskDomain[], reviewerName: reviewers.find((m) => m.id === x.assigneeMemberId)?.displayNameTh ?? '', since: x.createdAt })),
        overrides: overrides.map((o) => ({ id: o.id, number: o.number, status: o.status, supplierName: o.supplier.nameTh, expiresOn: iso(o.expiresOn)!, expiringSoon: o.status === 'APPROVED' })),
        openReviews: openReviews.map((r) => ({ id: r.id, supplier: r.supplier, reason: r.reason, tier: r.tier, dueAt: r.dueAt, registryFlag: r.registryFlag })),
        counts: { suppliers: supplierCount, openAssessments: assessmentCount, openSlots: slotCount, overrides: overrideCount, openReviews: reviewCount },
      },
    }
  })
}
