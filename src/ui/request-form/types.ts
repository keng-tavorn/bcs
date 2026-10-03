import type { AttachmentRule, Condition, VisibilityRule } from '@/core/forms'
import type { FieldDef } from '@/core/forms/fields'
import type { MoneyDto } from '@/core/money/dto'

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
}

export interface DraftQuotation {
  readonly supplierName: string
  readonly amount: string
  readonly includesVat: boolean
  readonly fileId: string | null
  readonly fileName: string | null
  readonly selected: boolean
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
}

export interface RequestFormData {
  readonly type: { readonly code: string; readonly name: string; readonly description: string | null; readonly documentType: DocumentType }
  readonly form: FormDefinition
  readonly requesterDepartmentName: string | null
  readonly budgetLines: readonly BudgetLineOption[]
  readonly defaultBudgetLineId: string | null
  readonly vatRateBp: number | null
  readonly attachmentKinds: readonly string[]
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
