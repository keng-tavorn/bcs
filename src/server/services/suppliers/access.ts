import { isJuristicTaxId } from '@/integrations/registry'
import { isAllowed, matchingGrants, type Principal } from '@/server/authz'

// What a reader may see of the supplier register (§2.4 supplier.view): every member the name and basic details
// (condition BASIC_FIELDS_ONLY), PROCUREMENT FINANCE and AUDITOR everything. BR-AUTH-04: an AUDITOR reads sensitive
// data masked unless another grant shows it in full — a Thai individual's tax id is their national id number, so an
// individual supplier's tax id (and the proof that carries it) is masked for a reader who sees the register in full only
// as AUDITOR. supplier.manage (PROCUREMENT) adds, edits and deactivates.

export interface SupplierAccess {
  /** FULL: tax id, address, contacts, Express vendor code, registry check and proofs · BASIC: name and basic details */
  readonly level: 'FULL' | 'BASIC'
  readonly canManage: boolean
  /** BR-AUTH-04: individual suppliers' tax ids are shown masked */
  readonly maskIndividualTaxIds: boolean
}

/** null: the reader may not view the register at all (an inactive member, the platform, the system) */
export function supplierAccess(principal: Principal): SupplierAccess | null {
  const grants = matchingGrants(principal, 'supplier.view')
  if (grants.length === 0) return null
  const full = grants.filter((g) => g.condition === undefined)
  return {
    level: full.length > 0 ? 'FULL' : 'BASIC',
    canManage: isAllowed(principal, 'supplier.manage'),
    maskIndividualTaxIds: full.length > 0 && full.every((g) => g.grantee.kind === 'ROLE' && g.grantee.role === 'AUDITOR'),
  }
}

/** A Thai individual (BR-SUP-02): a 13-digit tax id that does not start with 0 */
export const isIndividualTaxId = (taxId: string | null, isForeign: boolean): boolean => !isForeign && taxId !== null && !isJuristicTaxId(taxId)

/** BR-AUTH-04: all digits but the last four replaced, so the shape stays readable ("XXXXXXXXX0121") */
export const maskTaxId = (taxId: string): string => `${'X'.repeat(Math.max(0, taxId.length - 4))}${taxId.slice(-4)}`

/** The tax id as this reader may see it; null when they may not see it at all */
export function visibleTaxId(access: SupplierAccess, supplier: { taxId: string | null; isForeign: boolean }): { taxId: string | null; masked: boolean } | null {
  if (access.level !== 'FULL') return null
  if (supplier.taxId && access.maskIndividualTaxIds && isIndividualTaxId(supplier.taxId, supplier.isForeign)) return { taxId: maskTaxId(supplier.taxId), masked: true }
  return { taxId: supplier.taxId, masked: false }
}
