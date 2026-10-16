import { z } from 'zod'
import type { ReviewerSpec, WorkflowCondition, WorkflowRuleSnapshot, WorkflowVersionSnapshot } from '@/core/workflow'

// Database rows ↔ workflow engine snapshots (spec §7.17, S6-04). WorkflowRule.when, reviewers and fallback are JSON,
// checked with Zod on the way in so a damaged row fails loudly; money in a condition stays a baht string (§7.0 (3)).

const Code = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,39}$/)

export const ReviewerJson = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('POSITION_AT'), position: Code, department: Code }),
  z.strictObject({ kind: z.literal('MEMBER'), memberId: z.uuid() }),
])

const OPS = ['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty', 'anyIn'] as const

/** A condition of §7.9 with anyIn (BR-WF-07); {} holds for every request */
export const ConditionJson: z.ZodType<WorkflowCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionJson).min(1) }),
    z.strictObject({ any: z.array(ConditionJson).min(1) }),
    z.strictObject({ field: z.string().min(1).max(80), op: z.enum(OPS), value: z.unknown().optional() }),
    z.strictObject({}),
  ]),
) as z.ZodType<WorkflowCondition>

export interface WorkflowRuleRow {
  readonly code: string
  readonly requestTypeCodes: readonly string[]
  readonly when: unknown
  readonly reviewers: unknown
  readonly fallback: unknown
  readonly mode: string
  readonly quorumCount: number | null
  readonly slaBusinessMinutes: number
  readonly sortOrder: number
}

export interface WorkflowVersionRow {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: string
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
}

const RuleJson = z.object({
  when: ConditionJson,
  reviewers: z.array(ReviewerJson).min(1),
  fallback: ReviewerJson.nullable(),
  mode: z.enum(['ALL', 'ANY', 'COUNT']),
})
const Status = z.enum(['DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN'])

/** One stored rule as the engine reads it; throws with the rule code when the stored JSON is not a valid rule */
export function workflowRuleFromRow(row: WorkflowRuleRow): WorkflowRuleSnapshot {
  const parsed = RuleJson.safeParse(row)
  if (!parsed.success) throw new Error(`workflow rule ${row.code}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  return {
    code: row.code,
    requestTypeCodes: [...row.requestTypeCodes],
    when: parsed.data.when,
    reviewers: parsed.data.reviewers as ReviewerSpec[],
    fallback: (parsed.data.fallback as ReviewerSpec | null) ?? null,
    mode: parsed.data.mode,
    quorumCount: row.quorumCount,
    slaBusinessMinutes: row.slaBusinessMinutes,
    sortOrder: row.sortOrder,
  }
}

export function workflowVersionFromRows(version: WorkflowVersionRow, rules: readonly WorkflowRuleRow[]): WorkflowVersionSnapshot {
  return {
    id: version.id,
    code: version.code,
    versionNo: version.versionNo,
    status: Status.parse(version.status),
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo,
    rules: [...rules].sort((a, b) => a.sortOrder - b.sortOrder).map(workflowRuleFromRow),
  }
}

/** The JSON columns of one rule (the inverse of workflowRuleFromRow) */
export function workflowRuleJson(rule: WorkflowRuleSnapshot): { when: object; reviewers: object[]; fallback: object | null } {
  return { when: rule.when as object, reviewers: rule.reviewers.map((r) => ({ ...r })), fallback: rule.fallback ? { ...rule.fallback } : null }
}
