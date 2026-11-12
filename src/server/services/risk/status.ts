import type { Result } from '@/core/result'
import { poGate, type GateAssessment, type RegistryFlag, type RiskTierCode } from '@/core/risk'
import { dateIn } from '@/core/supplier-docs'
import { authorize, isAllowed, loadPrincipal } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import { riskModuleOn, supplierRiskStatusIn, type SupplierRiskStatusCode, type SupplierRiskStatusDto } from '@/server/queries/risk'
import type { SupplierRiskStatus } from '../sourcing/risk-link'
import { RISK_TIMEZONE } from './screening'
import { riskPolicyInEffect, riskTiersInEffect } from './tiers'

// What S10 reads of a supplier's risk (S11-10 · the interface table of docs/sub-specs/S10.md and S11.md · ADR-202 ADR-203
// ADR-207): supplierRiskStatus of queries/risk.ts plus whether a PO to the supplier would stop at the gate today and the
// policy's registryFlagBlocks. The gate is weighed by poGate of core with what is known without a PO — the supplier's
// tier (an inherent tier of a PO's work can only raise it), its assessment, its registry flag, and an approved override
// for every PO of the supplier with nothing used against its cap yet — so S10 warns where S11's gate would refuse; the
// gate itself stays at the PO (BR-RSK-09). S11-17 registers this function with registerSupplierRiskProvider.

const OPEN_ASSESSMENT = ['DRAFT', 'IN_REVIEW', 'RETURNED'] as const
const iso = (d: Date) => d.toISOString().slice(0, 10)

export async function supplierRiskProvider(tx: TenantTx, _organizationId: string, supplierId: string, now: Date): Promise<SupplierRiskStatus | null> {
  if (!(await riskModuleOn(tx))) return null
  const status = await supplierRiskStatusIn(tx, supplierId)
  if (!status) return null
  const [tiers, policy] = [await riskTiersInEffect(tx), await riskPolicyInEffect(tx)]
  // tiers or policy not confirmed: the module cannot be on (S11-02); say nothing rather than guess
  if (!tiers.ok || !policy.ok) return null
  const supplier = await tx.supplier.findFirstOrThrow({ where: { id: supplierId }, select: { registryFlag: true, registryFlaggedAt: true } })
  const current = await tx.riskAssessment.findFirst({ where: { supplierId, status: 'COMPLETED' }, select: { completedAt: true, validUntil: true } })
  const open = current ? 0 : await tx.riskAssessment.count({ where: { supplierId, status: { in: [...OPEN_ASSESSMENT] } } })
  const today = dateIn(now, RISK_TIMEZONE)
  const assessment: GateAssessment = current?.validUntil ? (iso(current.validUntil) >= today ? 'CURRENT' : 'OVERDUE') : open > 0 ? 'IN_PROGRESS' : 'NONE'
  const override = await tx.riskOverride.findFirst({ where: { supplierId, status: 'APPROVED', poId: null }, orderBy: [{ expiresOn: 'desc' }, { id: 'asc' }], select: { status: true, poId: true, expiresOn: true, capGrossSatang: true, usedGrossSatang: true } })
  const flaggedAt = supplier.registryFlaggedAt
  const decision = poGate({
    tier: (status.tier as RiskTierCode | null) ?? 'LOW',
    tiers: tiers.data,
    policy: policy.data,
    registryFlag: supplier.registryFlag as RegistryFlag,
    assessedAfterFlag: Boolean(current?.completedAt && flaggedAt && current.completedAt.getTime() > flaggedAt.getTime()),
    assessment,
    screeningCovered: true,
    override: override ? { status: override.status, poId: override.poId, expiresOn: iso(override.expiresOn), capGrossSatang: override.capGrossSatang, usedGrossSatang: override.usedGrossSatang } : null,
    poId: '',
    poDate: today,
    grossSatang: 0n,
    countedGrossSatang: 0n,
    trigger: 'SEND',
  })
  return { tier: status.tier, blocked: !decision.allowed, status: status.status, openOverrideId: status.openOverrideId, registryFlagBlocks: policy.data.registryFlagBlocks }
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
