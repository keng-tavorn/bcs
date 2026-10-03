// What the supplier screens receive (S4-02, FR-SUP-001). Screens may not import services, so these mirror the DTOs of
// src/server/services/suppliers/view.ts and index.ts; the pages pass the DTOs in and TypeScript checks that they fit.

export type ScreenLocale = 'th' | 'en'
export type SupplierStatus = 'ACTIVE' | 'INACTIVE'
export type RegistrySource = 'RD' | 'DBD' | 'MANUAL' | 'STUB'
export type RegistryAnswerStatus = 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE' | 'SKIPPED'

/** Name and basic details: what every member may see (§2.4 supplier.view) */
export interface SupplierBasicView {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly branchCode: string
  readonly category: string | null
  readonly status: SupplierStatus
  readonly isVatRegistered: boolean
  readonly isForeign: boolean
}

export interface SupplierListRowView extends SupplierBasicView {
  /** Readers who see the register in full only */
  readonly full: {
    readonly taxId: string | null
    readonly taxIdMasked: boolean
    readonly expressVendorCode: string | null
    readonly registrySource: RegistrySource | null
  } | null
}

export interface SupplierProofView {
  readonly fileId: string
  readonly fileName: string
  readonly sizeBytes: number
}

export interface SupplierDetailView {
  readonly level: 'FULL' | 'BASIC'
  readonly canManage: boolean
  readonly supplier: SupplierBasicView & { readonly version: number }
  readonly full: {
    readonly taxId: string | null
    readonly taxIdMasked: boolean
    readonly individual: boolean
    readonly address: string | null
    readonly email: string | null
    readonly phone: string | null
    readonly expressVendorCode: string | null
    readonly registry: {
      readonly source: RegistrySource | null
      readonly checkedAt: string | null
      readonly juristicStatus: string | null
      readonly recorded: {
        readonly mode: 'stub' | 'live' | null
        readonly rd: RegistryAnswerStatus
        readonly dbd: RegistryAnswerStatus
        readonly nameTh: string | null
        readonly address: string | null
        readonly vatRegistered: boolean | null
        readonly juristicStatus: string | null
      } | null
    }
    readonly proofs: readonly SupplierProofView[]
  } | null
}

/** What the registries said about a tax id and branch (lookupRegistry), and the supplier that already has them */
export interface RegistryCheckView {
  readonly proposal: {
    readonly taxId: string
    readonly branchCode: string
    readonly outcome: 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE'
    readonly sources: ReadonlyArray<'RD' | 'DBD' | 'STUB'>
    readonly nameTh: string | null
    readonly address: string | null
    readonly isVatRegistered: boolean | null
    readonly juristicStatus: string | null
    readonly individual: boolean
  }
  readonly existing: { readonly id: string; readonly code: string; readonly nameTh: string } | null
}

/** What the new-supplier form sends (createSupplier's input) */
export interface NewSupplierInput {
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly taxId: string | null
  readonly branchCode: string
  readonly isVatRegistered: boolean
  readonly isForeign: boolean
  readonly email: string | null
  readonly phone: string | null
  readonly address: string | null
  readonly category: string | null
  readonly expressVendorCode: string | null
  /** LOOKUP: the server checks the registries again; MANUAL: a person confirms with a proof file (BR-SUP-03) */
  readonly registry: { readonly check: 'LOOKUP' } | { readonly check: 'MANUAL'; readonly proofFileId: string } | null
}

/** One edit of a supplier (updateSupplier's input): the fields of one form, against the version seen */
export interface SupplierEditInput {
  readonly supplierId: string
  readonly expectedVersion: number
  readonly nameTh?: string
  readonly nameEn?: string | null
  readonly address?: string | null
  readonly isVatRegistered?: boolean
  readonly category?: string | null
  readonly expressVendorCode?: string | null
  readonly email?: string | null
  readonly phone?: string | null
  readonly status?: SupplierStatus
}
