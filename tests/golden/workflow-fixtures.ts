import type { ReviewerSpec, WorkflowCondition, WorkflowRuleSnapshot, WorkflowVersionSnapshot } from '@/core/workflow'
import type { Quorum } from '@/core/workflow/outcome'
import { loadYaml } from './doa-fixtures'

// Golden adapter for the workflow fixtures (spec §7.17): tests/golden/fixtures/workflow-versions.yaml as engine
// snapshots and the fields of each request type's form. Shapes only (codes stay codes, hours become minutes); it never
// changes an expected value.

type ReviewerFixture = { kind: 'POSITION_AT'; position: string; department: string } | { kind: 'MEMBER'; member: string }

export interface WorkflowRuleFixture {
  code: string
  requestTypes: string[]
  when: WorkflowCondition
  reviewers: ReviewerFixture[]
  fallback?: ReviewerFixture
  mode: Quorum
  quorumCount?: number
  slaBusinessHours: number
}

interface WorkflowFile {
  requestTypes: Record<string, string[]>
  versions: Array<{ code: string; version: number; effectiveFrom: string; rules: WorkflowRuleFixture[] }>
}

const reviewerOf = (r: ReviewerFixture): ReviewerSpec => (r.kind === 'MEMBER' ? { kind: 'MEMBER', memberId: r.member } : { kind: 'POSITION_AT', position: r.position, department: r.department })

export function workflowRuleOf(r: WorkflowRuleFixture, sortOrder: number): WorkflowRuleSnapshot {
  return {
    code: r.code,
    requestTypeCodes: r.requestTypes,
    when: r.when,
    reviewers: r.reviewers.map(reviewerOf),
    fallback: r.fallback ? reviewerOf(r.fallback) : null,
    mode: r.mode,
    quorumCount: r.quorumCount ?? null,
    slaBusinessMinutes: r.slaBusinessHours * 60,
    sortOrder,
  }
}

/** The workflow file a golden file names on its `fixtures:` line: its request types and its versions, PUBLISHED */
export function workflowFixture(files: readonly string[]): { requestTypes: Record<string, string[]>; versions: WorkflowVersionSnapshot[] } {
  const file = files.find((f) => f.includes('/workflow-versions'))
  if (!file) return { requestTypes: {}, versions: [] }
  const fx = loadYaml<WorkflowFile>(file)
  return {
    requestTypes: fx.requestTypes,
    versions: fx.versions.map((v) => ({ id: `${v.code}@${v.version}`, code: v.code, versionNo: v.version, status: 'PUBLISHED', effectiveFrom: new Date(v.effectiveFrom), effectiveTo: null, rules: v.rules.map(workflowRuleOf) })),
  }
}
