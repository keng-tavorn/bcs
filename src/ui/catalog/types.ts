// What the catalogue screens receive (S6-10 · FR-INT-102, §9.1 /catalog and /catalog/manage). Screens may not import
// services, so these mirror the services' DTOs (src/server/services/catalog/view.ts); the pages pass the DTOs in and
// TypeScript checks that they fit. Money as satang text, before VAT; days as YYYY-MM-DD.

export interface AgreementView {
  readonly id: string
  readonly supplierId: string
  readonly supplierCode: string
  readonly supplierName: string
  readonly unitPriceSatang: string
  /** Included */
  readonly validFrom: string
  /** Not included: the first day it no longer applies */
  readonly validTo: string
  readonly sourceRef: string | null
  readonly inEffect: boolean
  readonly ended: boolean
}

export interface CatalogItemView {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly uom: string
  readonly categoryCode: string
  readonly isService: boolean
  readonly accountCode: string | null
  readonly whtIncomeType: string | null
  readonly refUnitPriceSatang: string
  readonly active: boolean
  readonly agreements: readonly AgreementView[]
}

export interface SupplierChoice {
  readonly id: string
  readonly code: string
  readonly nameTh: string
}

/** The item form's values as typed (money as baht text) */
export interface ItemFormValues {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string
  readonly uom: string
  readonly categoryCode: string
  readonly isService: boolean
  readonly accountCode: string
  readonly whtIncomeType: string
  readonly refUnitPrice: string
  readonly active: boolean
}

/** What "บันทึกรายการ" sends for a new item */
export interface NewItemInput {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string
  readonly uom: string
  readonly categoryCode: string
  readonly isService: boolean
  readonly accountCode: string
  readonly whtIncomeType: string
  readonly refUnitPrice: string
}

/** What "บันทึกการแก้ไข" sends for an item */
export interface ItemEditInput extends Omit<NewItemInput, 'code'> {
  readonly catalogItemId: string
  readonly active: boolean
}

/** What "บันทึกราคาตกลง" sends: the last day the price applies, included (the action makes it the period's end) */
export interface NewAgreementInput {
  readonly catalogItemId: string
  readonly supplierId: string
  readonly unitPrice: string
  readonly validFrom: string
  readonly lastDay: string
  readonly sourceRef: string
}
