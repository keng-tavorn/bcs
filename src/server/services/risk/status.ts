import { poGate, type GateAssessment, type RegistryFlag, type RiskTierCode } from '@/core/risk'
import { dateIn } from '@/core/supplier-docs'
import type { TenantTx } from '@/server/db/tenant'
import { riskModuleOn, supplierRiskStatusIn } from '@/server/queries/risk'
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
