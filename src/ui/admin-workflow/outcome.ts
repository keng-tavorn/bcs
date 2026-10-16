import { toActionFailure, type ActionFailure } from '../admin-org/outcome'

// What a workflow server action returns to its form (§9.9 rule 7, §14.2): the admin forms' failure with what only the
// workflow's refusals carry — the lint errors with their field or request type (WORKFLOW_LINT_FAILED) and the test
// cases that do not pass (TEST_CASES_FAILED). Never the raw message.

export interface WorkflowIssue {
  readonly code: string
  readonly rule: string
  readonly requestType?: string
  readonly field?: string
}

export type WorkflowFailure = ActionFailure & {
  readonly lintErrors?: readonly WorkflowIssue[]
  readonly testCases?: readonly string[]
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function lintErrors(value: unknown): WorkflowIssue[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).code === 'string')
    .map((v) => ({ code: v.code as string, rule: text(v.rule) ?? '', ...(text(v.requestType) ? { requestType: text(v.requestType) } : {}), ...(text(v.field) ? { field: text(v.field) } : {}) }))
}

/** Picks the screen-safe parts of a workflow service error */
export function toWorkflowFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): WorkflowFailure {
  const d = error.details ?? {}
  const base = toActionFailure(error)
  const issues = error.code === 'WORKFLOW_LINT_FAILED' ? lintErrors(d.errors) : undefined
  const cases = Array.isArray(d.testCases) && d.testCases.every((t) => typeof t === 'string') ? (d.testCases as string[]) : undefined
  return { ...base, ...(issues ? { lintErrors: issues } : {}), ...(cases ? { testCases: cases } : {}) }
}

/** The reasons the workflow forms say in their own words (adminWorkflow.errors), before the shared admin ones */
export const WORKFLOW_REASONS = [
  'WARNINGS_NOT_ACKNOWLEDGED',
  'TEST_CASES_FAILED',
  'DRY_RUN_REQUIRED',
  'EFFECTIVE_IN_PAST',
  'LATER_VERSION_SCHEDULED',
  'DUPLICATE_RULE',
  'MEMBER',
  'POSITION',
  'DATE',
  'NO_DEPARTMENT',
  'CONFLICT_VERSION',
  'WORKFLOW_LINT_FAILED',
  'SOD_VIOLATION',
  'REVIEWER_NOT_FOUND',
] as const
export type WorkflowReason = (typeof WORKFLOW_REASONS)[number]
