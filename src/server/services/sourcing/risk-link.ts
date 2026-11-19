import type { TenantTx } from '@/server/db/tenant'
import { supplierRiskProvider } from '../risk/status'

// The supplier risk an invite records when the RISK module is on (BR-RFX-03 · S10-04): S11 registers its provider here
// (the registry keeps S10 from importing S11's service and S11 from editing S10's files). No provider, or RISK off → no
// badge. A risk only warns at invite time; it never blocks an invite (the gate of S11 sits before the PO).
// S11-17: S11's supplierRiskProvider is the provider from the start, not a call made when S11's module loads — a page or
// job of S10 that never imports services/risk (/sourcing/[id], the award) would otherwise read no risk at all. The
// provider says nothing with RISK off. Tests still register their own (registerSupplierRiskProvider).

export interface SupplierRiskStatus {
  /** The tier S11 assigned, e.g. LOW MEDIUM HIGH, or null when the supplier has no assessment yet */
  readonly tier: string | null
  /** Whether a PO to this supplier would stop at S11's gate today */
  readonly blocked: boolean
  // S10-10 (BR-RFX-12 จ · cross-checked with S11): what an award reads of its winner — optional, so a provider that
  // leaves them out still serves the invite's badge
  /** The status of the supplier's assessment, e.g. CURRENT EXPIRING OVERDUE REASSESS_REQUIRED; null without one */
  readonly status?: string | null
  /** An override of S11 that is open for the supplier */
  readonly openOverrideId?: string | null
  /** RiskPolicy.registryFlagBlocks (OQ-227): false lets a CEASED winner through with a reason; true or left out refuses it */
  readonly registryFlagBlocks?: boolean
}

export type SupplierRiskProvider = (tx: TenantTx, organizationId: string, supplierId: string, now: Date) => Promise<SupplierRiskStatus | null>

let provider: SupplierRiskProvider | null = supplierRiskProvider

/** Replaces the provider (tests: a fixed risk, or none with `async () => null`) */
export function registerSupplierRiskProvider(next: SupplierRiskProvider): void {
  provider = next
}

/** The supplier's risk for the invite's snapshot, or null when no provider is registered */
export async function supplierRiskStatus(tx: TenantTx, organizationId: string, supplierId: string, now: Date): Promise<SupplierRiskStatus | null> {
  return provider ? provider(tx, organizationId, supplierId, now) : null
}
