import type { AttachmentRule, Condition, VisibilityRule } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import type { MoneyDto } from '@/core/money/dto'
import type { AiReviewDraft } from '../ai/types'

// What the request form screens receive (S2-11). Screens may not import services, so these mirror the services' DTOs
// (src/server/services/requests/form-view.ts and preview.ts); the pages pass the DTOs in and TypeScript checks that
// they fit.

export type ScreenLocale = 'th' | 'en'
export type DocumentType = 'PURCHASE_REQUEST' | 'SUPPLIER_REQUEST'

export interface CatalogEntry {
  readonly code: string
  readonly name: string
  readonly description: string | null
  readonly documentType: DocumentType
}

export interface OpenDraft {
  readonly id: string
  readonly title: string
  readonly typeName: string
  readonly status: 'DRAFT' | 'RETURNED'
  readonly updatedAt: string
}

export interface FormDefinition {
  readonly fields: readonly FieldDef[]
  readonly visibility: readonly VisibilityRule[]
  readonly rules: readonly AttachmentRule[]
  readonly lines: { readonly serviceEndDate?: { readonly when: Condition } }
  /** The form's own steps (FormVersion.schema.steps, FR-INT-011 AC2); absent: the screen groups the fields itself */
  readonly steps?: ReadonlyArray<{ readonly key: string; readonly titleTh: string; readonly titleEn: string; readonly fields: readonly string[]; readonly optional: boolean }>
}

export interface BudgetLineOption {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly departmentId: string
  readonly departmentName: string
  readonly costCenterCode: string
  readonly costCenterName: string
  readonly granted: boolean
}

export interface DraftLine {
  readonly id: string
  /** What the line holds on the budget line while the request is returned (§6.4) */
  readonly reserved: MoneyDto | null
  readonly description: string
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly vatable: boolean
  readonly serviceEndDate: string | null
  /** S6-10: the catalogue item the line is (BR-PRC-06); absent or null: typed freely */
  readonly catalogItemId?: string | null
  /** S6-17 (BR-BUD-16): the line's own budget line; null: the request's */
  readonly budgetLineId?: string | null
}

export interface DraftQuotation {
  readonly supplierName: string
  /** The supplier of the register, when the Document Agent matched one (S13-07) */
  readonly supplierId?: string | null
  readonly amount: string
  readonly includesVat: boolean
  readonly fileId: string | null
  readonly fileName: string | null
  readonly selected: boolean
  /** An AI reading of the file still waiting for the requester (S13-07) */
  readonly ai?: AiReviewDraft | null
}

export interface Attachment {
  readonly fileId: string
  readonly fileName: string
  readonly kind: string
}

export interface RequestDraft {
  readonly requestId: string
  readonly version: number
  readonly status: 'DRAFT' | 'RETURNED'
  readonly title: string
  readonly budgetLineId: string | null
  readonly priceIncludesVat: boolean
  readonly formData: Readonly<Record<string, unknown>>
  readonly lines: readonly DraftLine[]
  readonly quotations: readonly DraftQuotation[]
  readonly nonLowestQuoteReason: string
  readonly attachments: readonly Attachment[]
  readonly returnReason: string | null
  /** Where the goods go (S4-02); absent or null: not chosen */
  readonly deliverySiteId?: string | null
  /** The supplier the requester suggests (FR-P2P-001 AC2) */
  readonly suggestedSupplierId?: string | null
  /** S6-10 (BR-PRC-06): why a catalogue item goes to another supplier than the agreed one; absent: none */
  readonly offAgreementReason?: string
  /** What the Intake Agent filled at step 0, still waiting for the requester (S13-08) */
  readonly intakeAi?: AiReviewDraft | null
}

export interface DeliverySiteOption {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly address: string | null
}

/** A supplier of the register a requester may suggest: the basic details every member sees (§2.4 supplier.view) */
export interface SupplierOption {
  readonly id: string
  readonly code: string
  readonly name: string
}

/**
 * An item of the catalogue as the request form offers it (S6-10, FR-INT-102): the active items with the agreed prices in
 * effect today (src/server/services/catalog/view.ts CatalogItemDto). Money as satang text, before VAT.
 */
export interface CatalogItemOption {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly nameEn: string | null
  readonly uom: string
  readonly categoryCode: string
  readonly refUnitPriceSatang: string
  readonly agreements: ReadonlyArray<{ readonly supplierId: string; readonly supplierCode: string; readonly supplierName: string; readonly unitPriceSatang: string }>
}

export interface RequestFormData {
  readonly type: { readonly code: string; readonly name: string; readonly description: string | null; readonly documentType: DocumentType }
  readonly form: FormDefinition
  readonly requesterDepartmentName: string | null
  readonly budgetLines: readonly BudgetLineOption[]
  readonly defaultBudgetLineId: string | null
  readonly vatRateBp: number | null
  readonly attachmentKinds: readonly string[]
  /** A purchase request's active delivery sites (absent: none offered) */
  readonly deliverySites?: readonly DeliverySiteOption[]
  /** BR-FORM-02: the site of the requester's latest request, or the organization's only site */
  readonly defaultDeliverySiteId?: string | null
  /** Active suppliers of the register a requester may suggest (absent: none offered) */
  readonly suppliers?: readonly SupplierOption[]
  /** S6-10: the catalogue items the draft's lines name, with today's agreed prices (absent: none, or not offered) */
  readonly catalogItems?: readonly CatalogItemOption[]
  readonly draft: RequestDraft | null
}

export interface RouteStepView {
  readonly stepNo: number
  readonly assigneeName: string
  readonly principalName: string | null
  readonly position: string | null
  readonly positionName: string | null
  readonly departmentName: string | null
}

export type RouteView =
  | { readonly kind: 'NO_ROUTE' }
  | { readonly kind: 'NEEDS_AMOUNT' }
  | {
      readonly kind: 'ROUTE'
      readonly doaCode: string
      readonly versionNo: number
      readonly ruleCode: string
      readonly escalatedFromRuleCode: string | null
      readonly amountBasis: 'GROSS' | 'NET'
      readonly basisAmount: MoneyDto | null
      readonly band: { readonly over: MoneyDto | null; readonly upTo: MoneyDto | null } | null
      readonly steps: readonly RouteStepView[]
      readonly explanationTh: string
    }
  | {
      readonly kind: 'BLOCKED'
      readonly code: string
      readonly ruleCode: string | null
      readonly position: string | null
      readonly positionName: string | null
      readonly departments: readonly string[]
    }

export type BudgetView =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'NOT_USABLE' }
  | { readonly kind: 'LINE'; readonly budgetLineId: string; readonly available: MoneyDto; readonly need: MoneyDto; readonly enough: boolean; readonly shortfall: MoneyDto }

export interface PreviewView {
  readonly totals: { readonly net: MoneyDto; readonly vat: MoneyDto; readonly gross: MoneyDto; readonly vatRateBp: number } | null
  readonly budget: BudgetView
  readonly route: RouteView
}

/** A request just sent: its number and who decides it now (the sent confirmation, §9.9 rule 7) */
export interface SentView {
  readonly number: string | null
  readonly waitingFor: ReadonlyArray<{ readonly name: string; readonly principalName: string | null }>
}

export interface PreviewRequestInput {
  readonly requestTypeCode: string
  readonly requestId: string | null
  readonly budgetLineId: string | null
  readonly priceIncludesVat: boolean
  readonly lines: ReadonlyArray<{ readonly quantity: string; readonly unitPrice: string; readonly vatable: boolean }>
}

/** S6-10: what the request form's catalogue search answers (src/app/(workspace)/requests/new/actions.ts) */
export type CatalogSearchOutcome =
  | { readonly ok: true; readonly items: readonly CatalogItemOption[]; readonly total: number; readonly limit: number }
  | { readonly ok: false; readonly code: string }

export type CatalogSearch = (q: string) => Promise<CatalogSearchOutcome>
