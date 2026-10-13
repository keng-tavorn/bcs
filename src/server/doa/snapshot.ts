import { z } from 'zod'
import {
  DOA_DOCUMENT_TYPES,
  isCommitteeStep,
  type DoaDocumentType,
  type DoaStepSpec,
  type DoaRuleSnapshot,
  type DoaVersionSnapshot,
  type DoaVersionStatus,
  type OrgSnapshot,
} from '@/core/doa'

// Database rows ↔ DOA engine snapshots (spec §7.4, §6.2). The engine is pure and never reads the database; services,
// the seed and the verify gate build its snapshots here. DoaRule.when and DoaRule.steps are JSON, where money is a
// decimal string of satang (JSON has no BigInt), checked with Zod on the way in so a damaged row fails loudly.

const SatangText = z
  .string()
  .regex(/^\d{1,18}$/, 'satang as a whole number written as text')
  .transform((v) => BigInt(v))

const AmountJson = z.strictObject({ gt: SatangText.optional(), gte: SatangText.optional(), lte: SatangText.optional() })

/** DoaRule.when as stored */
export const RuleWhenJson = z.strictObject({ amount: AmountJson.optional() })

const ApproverJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('POSITION_OF_DEPARTMENT'), position: z.string().min(1) }),
  z.strictObject({ kind: z.literal('POSITION_OF_ORG'), position: z.string().min(1) }),
  z.strictObject({ kind: z.literal('MEMBER'), memberId: z.uuid() }),
])

const SingleStepJson = z.strictObject({ approver: ApproverJson, slaBusinessMinutes: z.number().int().positive(), mode: z.enum(['SEQUENTIAL', 'PARALLEL']) })

/** A committee (S6 · FR-WF-102): { approvers, mode: PARALLEL, quorum, quorumCount?, slaBusinessMinutes }; lint checks the
 * quorum against the number of approvers (BR-WF-05), the shape only that it is one */
const CommitteeStepJson = z.strictObject({
  approvers: z.array(ApproverJson).min(1),
  slaBusinessMinutes: z.number().int().positive(),
  mode: z.literal('PARALLEL'),
  quorum: z.enum(['ALL', 'ANY', 'COUNT', 'MAJORITY']),
  quorumCount: z.number().int().positive().optional(),
})

/** DoaRule.steps as stored: each step has one approver or a committee of approvers, never both */
export const RuleStepsJson = z.array(z.union([SingleStepJson, CommitteeStepJson])).min(1)

export interface DoaRuleRow {
  readonly code: string
  readonly documentType: string
  readonly priority: number
  readonly when: unknown
  readonly steps: unknown
  readonly descriptionTh: string | null
}

export interface DoaVersionRow {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
  readonly amountBasis: string
  readonly selfApprovalPolicy: string
  readonly collapseDuplicateApprovers: boolean
}

const DocumentType = z.enum(DOA_DOCUMENT_TYPES)
const VersionFields = z.object({
  status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN']),
  amountBasis: z.enum(['GROSS', 'NET']),
  selfApprovalPolicy: z.enum(['ESCALATE_NEXT_BAND', 'BLOCK']),
})

/** One stored rule as the engine reads it; throws with the rule code when the stored JSON is not a valid rule. */
export function ruleSnapshotFromRow(row: DoaRuleRow): DoaRuleSnapshot {
  const parsed = z.object({ documentType: DocumentType, when: RuleWhenJson, steps: RuleStepsJson }).safeParse(row)
  if (!parsed.success) throw new Error(`DOA rule ${row.code}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const { amount } = parsed.data.when
  return {
    code: row.code,
    documentType: parsed.data.documentType,
    priority: row.priority,
    when: amount ? { amount: { ...amount } } : {},
    steps: parsed.data.steps.map((s): DoaStepSpec => ('approvers' in s ? { ...s, approvers: s.approvers.map((a) => ({ ...a })) } : { ...s, approver: { ...s.approver } })),
    ...(row.descriptionTh ? { descriptionTh: row.descriptionTh } : {}),
  }
}

/** A stored version and its rules as one engine snapshot. */
export function versionSnapshotFromRows(version: DoaVersionRow, rules: readonly DoaRuleRow[]): DoaVersionSnapshot {
  const fields = VersionFields.parse(version)
  return {
    id: version.id,
    code: version.code,
    versionNo: version.versionNo,
    status: fields.status as DoaVersionStatus,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    amountBasis: fields.amountBasis,
    selfApprovalPolicy: fields.selfApprovalPolicy,
    collapseDuplicateApprovers: version.collapseDuplicateApprovers,
    rules: rules.map(ruleSnapshotFromRow),
  }
}

const satangText = (v: bigint | undefined) => (v === undefined ? undefined : v.toString())

/** One step as DoaRule.steps stores it, keys in a fixed order */
function stepJson(step: DoaStepSpec): object {
  if (!isCommitteeStep(step)) return { approver: { ...step.approver }, slaBusinessMinutes: step.slaBusinessMinutes, mode: step.mode }
  return {
    approvers: step.approvers.map((a) => ({ ...a })),
    slaBusinessMinutes: step.slaBusinessMinutes,
    mode: step.mode,
    quorum: step.quorum,
    ...(step.quorumCount !== undefined ? { quorumCount: step.quorumCount } : {}),
  }
}

/** The JSON columns of DoaRule for one engine rule (the inverse of ruleSnapshotFromRow). */
export function ruleJson(rule: DoaRuleSnapshot): { documentType: DoaDocumentType; when: object; steps: object[] } {
  const amount = rule.when.amount
  const when = amount
    ? { amount: Object.fromEntries(Object.entries({ gt: satangText(amount.gt), gte: satangText(amount.gte), lte: satangText(amount.lte) }).filter(([, v]) => v !== undefined)) }
    : {}
  return { documentType: rule.documentType, when, steps: rule.steps.map(stepJson) }
}

export interface OrgRows {
  readonly departments: ReadonlyArray<{ id: string; code: string; nameTh: string; parentId: string | null }>
  readonly holders: ReadonlyArray<{ positionCode: string; departmentId: string; memberId: string; validFrom: Date; validTo: Date | null }>
  readonly members: ReadonlyArray<{ id: string; displayNameTh: string; status: string }>
}

/** The organization structure the DOA engine resolves approvers in. Only ACTIVE members can approve. */
export function orgSnapshotFromRows(rows: OrgRows): OrgSnapshot {
  return {
    departments: rows.departments.map((d) => ({ id: d.id, code: d.code, nameTh: d.nameTh, parentId: d.parentId })),
    holders: rows.holders.map((h) => ({ positionCode: h.positionCode, departmentId: h.departmentId, memberId: h.memberId, validFrom: h.validFrom, validTo: h.validTo })),
    members: rows.members.map((m) => ({ id: m.id, displayNameTh: m.displayNameTh, active: m.status === 'ACTIVE' })),
  }
}
