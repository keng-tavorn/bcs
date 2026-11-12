import type { RiskTierCode } from '@/core/risk'
import type { TenantTx } from '@/server/db/tenant'

// The supplier's risk as other screens and steps read it (S11-10 · BR-RSK-14 · FR-RSK-204): Supplier's projection (tier,
// status, until when, the assessment behind it) and the override still being asked for. Read only, no right checked:
// supplierRiskStatus and supplierRiskBadges of services/risk/status.ts check the reader (risk.assessment.view reads all of
// it, supplier.view the tier and the status) and S10's provider there adds whether today's gate would stop a PO.

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
