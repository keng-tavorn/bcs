import { registerFileSubjectPolicy } from '../files/policies'
import { isIndividualTaxId, supplierAccess } from './access'

// FR-PLT-004 AC2 for the proof a person attached when the registries could not confirm a supplier (BR-SUP-03, FileLink
// subjectType "Supplier", kind REGISTRY_PROOF): it downloads for those who see the register in full (§2.4 supplier.view
// without BASIC_FIELDS_ONLY). An individual's proof carries their national id number, so a reader who sees tax ids masked
// (BR-AUTH-04) does not get it. A supplier that does not exist gives no access (deny by default, BR-AUTH-01).
registerFileSubjectPolicy('Supplier', async (tx, _ctx, principal, supplierId) => {
  const access = supplierAccess(principal)
  if (access?.level !== 'FULL') return false
  const supplier = await tx.supplier.findFirst({ where: { id: supplierId }, select: { taxId: true, isForeign: true } })
  if (!supplier) return false
  return !(access.maskIndividualTaxIds && isIndividualTaxId(supplier.taxId, supplier.isForeign))
})
