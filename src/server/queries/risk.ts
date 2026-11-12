import type { Result } from '@/core/result'
import type { RiskTierCode } from '@/core/risk'
import { authorize, isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'

// The supplier's risk as other screens and steps read it (S11-10 · BR-RSK-14 · FR-RSK-204): Supplier's projection (tier,
// status, until when, the assessment behind it) and the override still being asked for. Read only. Whoever reads the risk
// files (risk.assessment.view) reads all of it; whoever reads only the supplier register (supplier.view) reads the tier
// and the status, nothing that leads into the file. Nothing at all with RISK off. S10 reads the same through the provider
// S11 registers (services/risk/status.ts), which adds whether today's gate would stop a PO.

export type SupplierRiskStatusCode = 'NOT_ASSESSED' | 'IN_PROGRESS' | 'CURRENT' | 'EXPIRING' | 'OVERDUE' | 'REASSESS_REQUIRED'

export interface SupplierRiskStatusDto {
  readonly tier: RiskTierCode | null
  readonly status: SupplierRiskStatusCode
  /** ISO date, the last day the current assessment is valid (risk.assessment.view only) */
  readonly validUntil?: string | null
  readonly currentAssessmentId?: string | null
  /** An override asked, sent or returned and not decided yet (risk.assessment.view only) */
  readonly openOverrideId?: string | null
}

const OPEN_OVERRIDE = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] as const
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/** RISK switched on for the organization of the transaction */
export async function riskModuleOn(tx: TenantTx): Promise<boolean> {
  return (await tx.orgModule.findFirst({ where: { module: 'RISK', enabled: true }, select: { id: true } })) !== null
}

/** The full status of one supplier, no right checked (the caller checked it); null for a supplier not of the organization */
export async function supplierRiskStatusIn(tx: TenantTx, supplierId: string): Promise<Required<SupplierRiskStatusDto> | null> {
  const s = await tx.supplier.findFirst({ where: { id: supplierId }, select: { riskTier: true, riskStatus: true, riskValidUntil: true, currentRiskAssessmentId: true } })
  if (!s) return null
  const open = await tx.riskOverride.findFirst({ where: { supplierId, status: { in: [...OPEN_OVERRIDE] } }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  return { tier: s.riskTier, status: s.riskStatus, validUntil: iso(s.riskValidUntil), currentAssessmentId: s.currentRiskAssessmentId, openOverrideId: open?.id ?? null }
}

/**
 * supplierRiskStatus(ctx, supplierId) of the sub-spec's interface table: MODULE_DISABLED with RISK off, FORBIDDEN for a
 * reader of neither the risk files nor the register, NOT_FOUND for a supplier of another organization.
 */
export async function supplierRiskStatus(ctx: Ctx, supplierId: string): Promise<Result<SupplierRiskStatusDto>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    if (!(await riskModuleOn(tx))) return { ok: false as const, error: { code: 'MODULE_DISABLED' as const, message: 'module RISK is off', details: { module: 'RISK' } } }
    const principal = await loadPrincipal(tx, ctx)
    const full = isAllowed(principal, 'risk.assessment.view')
    if (!full) {
      const basic = await authorize(tx, ctx, 'supplier.view')
      if (!basic.ok) return basic
    }
    const status = await supplierRiskStatusIn(tx, supplierId)
    if (!status) return { ok: false as const, error: { code: 'NOT_FOUND' as const, message: 'supplier not found' } }
    return { ok: true as const, data: full ? status : { tier: status.tier, status: status.status } }
  })
}

/**
 * The badges of the supplier list (/suppliers): tier and status per supplier given, for a reader of the register or of the
 * risk files; an empty map with RISK off or for anyone else.
 */
export async function supplierRiskBadges(ctx: Ctx, supplierIds: readonly string[]): Promise<ReadonlyMap<string, { readonly tier: RiskTierCode | null; readonly status: SupplierRiskStatusCode }>> {
  const out = new Map<string, { tier: RiskTierCode | null; status: SupplierRiskStatusCode }>()
  if (supplierIds.length === 0) return out
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    if (!(await riskModuleOn(tx))) return out
    const principal = await loadPrincipal(tx, ctx)
    if (!isAllowed(principal, 'risk.assessment.view') && !isAllowed(principal, 'supplier.view')) return out
    const rows = await tx.supplier.findMany({ where: { id: { in: [...new Set(supplierIds)] } }, select: { id: true, riskTier: true, riskStatus: true } })
    for (const r of rows) out.set(r.id, { tier: r.riskTier, status: r.riskStatus })
    return out
  })
}
