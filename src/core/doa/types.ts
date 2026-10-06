// DOA engine types (spec §7.4, §6.2). Snapshots are plain data built by the server from the database (or from YAML
// fixtures in tests); the engine never reads anything itself. Money is BigInt satang throughout (ADR-018).

export const DOA_DOCUMENT_TYPES = ['PURCHASE_REQUEST', 'PURCHASE_ORDER', 'GR_VARIANCE', 'DOA_CHANGE', 'ORG_AUTHORITY_CHANGE'] as const
export type DoaDocumentType = (typeof DOA_DOCUMENT_TYPES)[number]

/** Purchase documents must carry an amount above zero (BR-DOA-02). */
export const PURCHASE_DOCUMENT_TYPES: readonly DoaDocumentType[] = ['PURCHASE_REQUEST', 'PURCHASE_ORDER']
/** Policy changes every version must be able to approve (BR-DOA-08 (จ)). */
export const GOVERNANCE_DOCUMENT_TYPES: readonly DoaDocumentType[] = ['DOA_CHANGE', 'ORG_AUTHORITY_CHANGE']

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
  /** Documents without an amount (DOA_CHANGE, ORG_AUTHORITY_CHANGE) leave it out */
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
