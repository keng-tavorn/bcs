// DOA engine types (spec §7.4, §6.2). Snapshots are plain data built by the server from the database (or from YAML
// fixtures in tests); the engine never reads anything itself. Money is BigInt satang throughout (ADR-018).

import type { ApprovalSubject } from '@/core/sod'

/** The order lint reports in (BR-DOA-23); the first five are the tier-1 types, the rest came with phase 1 (P1-07). */
export const DOA_DOCUMENT_TYPES = [
  'PURCHASE_REQUEST',
  'PURCHASE_ORDER',
  'GR_VARIANCE',
  'DOA_CHANGE',
  'ORG_AUTHORITY_CHANGE',
  'BUDGET_TRANSFER',
  'OVER_BUDGET',
  'INVOICE_EXCEPTION',
  'PO_CHANGE',
  'PAYMENT_RUN',
  'BANK_ACCOUNT_CHANGE',
] as const
export type DoaDocumentType = (typeof DOA_DOCUMENT_TYPES)[number]

/** REQUIRED: an amount above zero (BR-DOA-02, BR-DOA-21) · OPTIONAL: either way (tier-1 behaviour) · NONE: never (BR-DOA-22). */
export type AmountRequirement = 'REQUIRED' | 'OPTIONAL' | 'NONE'

/**
 * What a document type is (BR-DOA-20): data only, never a limit, a position or a route (P-2). A type is switched on
 * for an organisation by having rules in its DOA, not by a flag.
 */
export interface DocTypeTraits {
  readonly amount: AmountRequirement
  /** false: the owner routes it with vatSatang = 0, so GROSS and NET give the same result (BR-DOA-21) */
  readonly vat: boolean
  /** A policy change every version must be able to approve (BR-DOA-08 (จ)) */
  readonly governance: boolean
  /** Every version needs a rule of this type while one of these modules is on (BR-DOA-23) */
  readonly requiredWithModules: readonly string[]
  /** The approval subjects that may route with this type (BR-DOA-20) */
  readonly subjects: readonly ApprovalSubject[]
}

export const DOC_TYPE_TRAITS: Readonly<Record<DoaDocumentType, DocTypeTraits>> = {
  PURCHASE_REQUEST: { amount: 'REQUIRED', vat: true, governance: false, requiredWithModules: [], subjects: ['REQUEST'] },
  PURCHASE_ORDER: { amount: 'REQUIRED', vat: true, governance: false, requiredWithModules: [], subjects: ['PURCHASE_ORDER'] },
  GR_VARIANCE: { amount: 'OPTIONAL', vat: false, governance: false, requiredWithModules: [], subjects: ['VARIANCE'] },
  DOA_CHANGE: { amount: 'OPTIONAL', vat: false, governance: true, requiredWithModules: [], subjects: ['DOA_VERSION', 'WORKFLOW_VERSION'] },
  ORG_AUTHORITY_CHANGE: { amount: 'OPTIONAL', vat: false, governance: true, requiredWithModules: [], subjects: ['ORG_AUTHORITY_CHANGE'] },
  BUDGET_TRANSFER: { amount: 'REQUIRED', vat: false, governance: false, requiredWithModules: [], subjects: ['BUDGET_TRANSFER'] },
  OVER_BUDGET: { amount: 'REQUIRED', vat: false, governance: false, requiredWithModules: [], subjects: ['BUDGET_OVERRUN'] },
  INVOICE_EXCEPTION: { amount: 'REQUIRED', vat: true, governance: false, requiredWithModules: ['PAY'], subjects: ['INVOICE'] },
  PO_CHANGE: { amount: 'REQUIRED', vat: true, governance: false, requiredWithModules: [], subjects: ['PO_CHANGE'] },
  PAYMENT_RUN: { amount: 'REQUIRED', vat: false, governance: false, requiredWithModules: ['PAY'], subjects: ['PAYMENT_RUN'] },
  BANK_ACCOUNT_CHANGE: { amount: 'NONE', vat: false, governance: false, requiredWithModules: ['PAY'], subjects: ['BANK_ACCOUNT_CHANGE'] },
}

/** Policy changes every version must be able to approve (BR-DOA-08 (จ)). */
export const GOVERNANCE_DOCUMENT_TYPES: readonly DoaDocumentType[] = DOA_DOCUMENT_TYPES.filter((t) => DOC_TYPE_TRAITS[t].governance)
/** Types whose rules carry no amount band: the editor hides the limit and the simulator the amount. */
export const NO_AMOUNT_DOCUMENT_TYPES: readonly DoaDocumentType[] = DOA_DOCUMENT_TYPES.filter((t) => DOC_TYPE_TRAITS[t].governance || DOC_TYPE_TRAITS[t].amount === 'NONE')

/** The one document type a subject routes with (BR-DOA-20: every subject is in exactly one type's list). */
export function documentTypeOfSubject(subject: ApprovalSubject): DoaDocumentType {
  return DOA_DOCUMENT_TYPES.find((t) => DOC_TYPE_TRAITS[t].subjects.includes(subject))!
}

/** BR-DOA-23: the types every version must have rules for while these modules are on, in DOA_DOCUMENT_TYPES order. */
export function requiredDocumentTypes(modules: readonly string[] = []): DoaDocumentType[] {
  return DOA_DOCUMENT_TYPES.filter((t) => DOC_TYPE_TRAITS[t].governance || DOC_TYPE_TRAITS[t].requiredWithModules.some((m) => modules.includes(m)))
}

/** The modules that make a type required, each with the types it requires (BR-DOA-24). */
export function moduleRequiredDocumentTypes(module: string): DoaDocumentType[] {
  return DOA_DOCUMENT_TYPES.filter((t) => DOC_TYPE_TRAITS[t].requiredWithModules.includes(module))
}

export type AmountBasis = 'GROSS' | 'NET'
export type SelfApprovalPolicy = 'ESCALATE_NEXT_BAND' | 'BLOCK'
export type DoaVersionStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'PUBLISHED' | 'SUPERSEDED' | 'REJECTED' | 'WITHDRAWN'

/** Amount band in satang (BR-DOA-02): lower bound exclusive (`gt`) or inclusive (`gte`), upper bound inclusive (`lte`). */
export interface AmountCondition {
  readonly gt?: bigint
  readonly gte?: bigint
  readonly lte?: bigint
}

export interface DoaWhen {
  readonly amount?: AmountCondition
}

export type ApproverSpec =
  | { readonly kind: 'POSITION_OF_DEPARTMENT'; readonly position: string }
  | { readonly kind: 'POSITION_OF_ORG'; readonly position: string }
  | { readonly kind: 'MEMBER'; readonly memberId: string }

export interface DoaStepSpec {
  readonly approver: ApproverSpec
  readonly slaBusinessMinutes: number
  /** Tier 1 uses SEQUENTIAL only; lint refuses PARALLEL until S6 (BR-DOA-08 (ค)) */
  readonly mode: 'SEQUENTIAL' | 'PARALLEL'
}

export interface DoaRuleSnapshot {
  readonly code: string
  readonly documentType: DoaDocumentType
  readonly priority: number
  readonly when: DoaWhen
  readonly steps: readonly DoaStepSpec[]
  readonly descriptionTh?: string
}

export interface DoaVersionSnapshot {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: DoaVersionStatus
  readonly effectiveFrom: Date
  /** null = until a later version takes over */
  readonly effectiveTo: Date | null
  readonly amountBasis: AmountBasis
  readonly selfApprovalPolicy: SelfApprovalPolicy
  readonly collapseDuplicateApprovers: boolean
  readonly rules: readonly DoaRuleSnapshot[]
}

export interface DepartmentSnapshot {
  readonly id: string
  readonly code: string
  readonly nameTh: string
  readonly parentId: string | null
}

export interface PositionHolderSnapshot {
  readonly positionCode: string
  readonly departmentId: string
  readonly memberId: string
  readonly validFrom: Date
  /** null = still holds it */
  readonly validTo: Date | null
}

export interface MemberSnapshot {
  readonly id: string
  readonly displayNameTh: string
  readonly active: boolean
}

export interface OrgSnapshot {
  readonly departments: readonly DepartmentSnapshot[]
  readonly holders: readonly PositionHolderSnapshot[]
  readonly members: readonly MemberSnapshot[]
}

export type DelegationStatus = 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'REVOKED'

export interface DelegationSnapshot {
  readonly id: string
  readonly delegatorMemberId: string
  readonly delegateMemberId: string
  /** [startsAt, endsAt) (BR-DLG-03) */
  readonly startsAt: Date
  readonly endsAt: Date
  /** null or empty = every document type, governance included (BR-DLG-01, ADR-038 ข้อ 6) */
  readonly documentTypes: readonly DoaDocumentType[] | null
  /** null = no cap; a cap never covers documents without an amount (ADR-038 ข้อ 7) */
  readonly maxAmountSatang: bigint | null
  readonly status: DelegationStatus
}

export interface RouteInput {
  readonly documentType: DoaDocumentType
  /** Types whose amount is NONE leave it out; OPTIONAL types may (DOC_TYPE_TRAITS) */
  readonly amount?: { readonly netSatang: bigint; readonly vatSatang: bigint }
  readonly requesterMemberId: string
  /** The department that pays (BR-DOA-05, OQ-27), not the requester's own */
  readonly chargedDepartmentId: string
  /** Requester, requesters of source PRs, PO creator, DOA submitter (BR-DOA-06, BR-SOD-01/03/06) */
  readonly conflictMemberIds: readonly string[]
  /** When the document is submitted */
  readonly at: Date
}

export interface RouteStep {
  readonly stepNo: number
  readonly assigneeMemberId: string
  /** The delegator when a delegate holds the task (BR-DLG-04); null otherwise */
  readonly principalMemberId: string | null
  /** Where the approver came from, e.g. "POSITION:VP@OPS" or "MEMBER:<id>" */
  readonly resolvedFrom: string
  readonly slaBusinessMinutes: number
  /** The delegate conflicts with the document, so the task stays with the delegator; ORG_ADMIN is told (BR-DLG-05) */
  readonly notifyOrgAdmin: boolean
}

export interface RouteResult {
  readonly doaVersionId: string
  readonly doaCode: string
  readonly versionNo: number
  /** The rule whose approvers the route uses */
  readonly ruleCode: string
  /** The rule the amount fell into when its approver conflicted (BR-DOA-06) */
  readonly escalatedFromRuleCode: string | null
  readonly amountBasis: AmountBasis
  readonly basisAmountSatang: bigint | null
  readonly steps: readonly RouteStep[]
  readonly explanationTh: string
}
