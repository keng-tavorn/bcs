// The read models the S8 parts of the purchase-order screens draw (src/server/queries/po-changes.ts and
// src/server/services/purchase-orders/view-change.ts return these shapes); money is bigint satang, formatted here.

export interface PoChangeLineView {
  readonly poLineId: string
  readonly lineNo: number
  readonly description: string
  readonly uom: string
  readonly oldQuantity: string
  readonly newQuantity: string
  readonly oldUnitPriceSatang: bigint
  readonly newUnitPriceSatang: bigint
  readonly oldNetSatang: bigint
  readonly newNetSatang: bigint
}

export interface PoChangeTotalsView {
  readonly netSatang: bigint
  readonly vatSatang: bigint
  readonly grossSatang: bigint
}

export interface PoChangeView {
  readonly id: string
  readonly changeNo: number
  readonly status: string
  readonly autoApproved: boolean
  readonly reason: string | null
  readonly old: PoChangeTotalsView
  readonly new: PoChangeTotalsView
  readonly deliveryDate: string | null
  readonly notesToSupplier: string | null
  readonly quantityDisposition: string | null
  readonly createdBy: { readonly id: string; readonly name: { readonly th: string; readonly en: string | null } }
  readonly createdAt: Date
  readonly submittedAt: Date | null
  readonly appliedRevisionNo: number | null
  readonly sentAt: Date | null
  readonly version: number
  readonly lines: readonly PoChangeLineView[]
}

export interface ApInvoiceRowView {
  readonly id: string
  readonly number: string | null
  readonly supplierInvoiceNo: string | null
  readonly status: string
  readonly payableSatang: bigint
}

export const nameOf = (locale: string, name: { readonly th: string; readonly en: string | null }): string => (locale === 'en' && name.en ? name.en : name.th)
