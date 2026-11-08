import type { TenantTx } from '@/server/db/tenant'

// The supplier risk an invite records when the RISK module is on (BR-RFX-03 · S10-04): S11 registers its provider here
// (the registry keeps S10 from importing S11's service and S11 from editing S10's files). No provider, or RISK off → no
// badge. A risk only warns at invite time; it never blocks an invite (the gate of S11 sits before the PO).

export interface SupplierRiskStatus {
  /** The tier S11 assigned, e.g. LOW MEDIUM HIGH, or null when the supplier has no assessment yet */
  readonly tier: string | null
  /** Whether a PO to this supplier would stop at S11's gate today */
  readonly blocked: boolean
}

export type SupplierRiskProvider = (tx: TenantTx, organizationId: string, supplierId: string, now: Date) => Promise<SupplierRiskStatus | null>

let provider: SupplierRiskProvider | null = null

/** S11 calls this once when its module loads */
export function registerSupplierRiskProvider(next: SupplierRiskProvider): void {
  provider = next
}

/** The supplier's risk for the invite's snapshot, or null when no provider is registered */
export async function supplierRiskStatus(tx: TenantTx, organizationId: string, supplierId: string, now: Date): Promise<SupplierRiskStatus | null> {
  return provider ? provider(tx, organizationId, supplierId, now) : null
}
