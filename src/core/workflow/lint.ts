import type { OrgSnapshot } from '../doa/types'
import { RISK_DOMAINS, RISK_REVIEW_VARIABLES, SCREENING_FIELDS } from '../risk/types'
import { resolveReviewer, WORKFLOW_VARIABLES, type WorkflowCondition, type WorkflowVersionSnapshot } from './reviewers'

// lintWorkflowVersion (spec §7.17 BR-WF-11): what stops a workflow version from being sent (errors) and what its sender
// ticks (warnings). Issues come rule by rule in the version's order; within a rule errors first in this order: request
// type, fields, quorum; a code used twice is named at its second rule. A rule of RISK_ASSESSMENT scope (S11 · BR-RSK-07)
// names no request type: its own checks come first in this order — domains, fields, quorum — and the request-type checks
// never see it.

export type WorkflowLintCode =
  | 'WF_LINT_UNKNOWN_REQUEST_TYPE'
  | 'WF_LINT_UNKNOWN_FIELD'
  | 'WF_LINT_DUPLICATE_CODE'
  | 'WF_LINT_QUORUM_INVALID'
  | 'WF_LINT_VACANT_REVIEWER'
  | 'WF_LINT_NO_FALLBACK'
  | 'WF_LINT_MEMBER_REVIEWER'
  // S11-06 (BR-RSK-07): a RISK_ASSESSMENT rule names at least one known domain, only screening answers and the risk
  // variables, and one reviewer of quorum ALL
  | 'WF_LINT_RISK_DOMAIN_REQUIRED'
  | 'WF_LINT_RISK_FIELD'
  | 'WF_LINT_RISK_QUORUM'

export interface WorkflowLintIssue {
  readonly code: WorkflowLintCode
  readonly rule: string
  readonly requestType?: string
  readonly field?: string
}

export interface WorkflowLintResult {
  readonly errors: readonly WorkflowLintIssue[]
  readonly warnings: readonly WorkflowLintIssue[]
}

/** The fields of the current form of each request type (BR-WF-11: a condition names a field every type of the rule has) */
export type RequestTypeFields = Readonly<Record<string, readonly string[]>>

function fieldsOf(when: WorkflowCondition): string[] {
  if ('all' in when) return (when.all as readonly WorkflowCondition[]).flatMap(fieldsOf)
  if ('any' in when) return (when.any as readonly WorkflowCondition[]).flatMap(fieldsOf)
  return 'field' in when ? [(when as { field: string }).field] : []
}

export function lintWorkflowVersion(version: WorkflowVersionSnapshot, org: OrgSnapshot, requestTypes: RequestTypeFields, at: Date): WorkflowLintResult {
  const errors: WorkflowLintIssue[] = []
  const warnings: WorkflowLintIssue[] = []
  const seen = new Set<string>()
  const riskFields: readonly string[] = [...SCREENING_FIELDS, ...RISK_REVIEW_VARIABLES]
  for (const rule of version.rules) {
    if (rule.scope === 'RISK_ASSESSMENT') {
      const domains = rule.riskDomains ?? []
      if (domains.length === 0 || domains.some((d) => !(RISK_DOMAINS as readonly string[]).includes(d))) errors.push({ code: 'WF_LINT_RISK_DOMAIN_REQUIRED', rule: rule.code })
      for (const field of [...new Set(fieldsOf(rule.when))]) if (!riskFields.includes(field)) errors.push({ code: 'WF_LINT_RISK_FIELD', rule: rule.code, field })
      if (rule.mode !== 'ALL' || rule.reviewers.length !== 1 || rule.quorumCount !== null) errors.push({ code: 'WF_LINT_RISK_QUORUM', rule: rule.code })
    } else {
      lintRequestRule(rule, requestTypes, errors)
    }
    if (seen.has(rule.code)) errors.push({ code: 'WF_LINT_DUPLICATE_CODE', rule: rule.code })
    seen.add(rule.code)

    if (rule.reviewers.some((r) => r.kind !== 'MEMBER' && resolveReviewer(r, org, at) === null)) warnings.push({ code: 'WF_LINT_VACANT_REVIEWER', rule: rule.code })
    if (rule.fallback === null) warnings.push({ code: 'WF_LINT_NO_FALLBACK', rule: rule.code })
    if (rule.reviewers.some((r) => r.kind === 'MEMBER')) warnings.push({ code: 'WF_LINT_MEMBER_REVIEWER', rule: rule.code })
  }
  return { errors, warnings }
}

/** The checks of a REQUEST rule (BR-WF-11): its request types, the fields of their forms, its quorum */
function lintRequestRule(rule: WorkflowVersionSnapshot['rules'][number], requestTypes: RequestTypeFields, errors: WorkflowLintIssue[]): void {
  for (const type of rule.requestTypeCodes) if (!(type in requestTypes)) errors.push({ code: 'WF_LINT_UNKNOWN_REQUEST_TYPE', rule: rule.code, requestType: type })
  const known = rule.requestTypeCodes.filter((t) => t in requestTypes)
  for (const field of [...new Set(fieldsOf(rule.when))]) {
    if (WORKFLOW_VARIABLES.includes(field)) continue
    if (known.length === 0 || known.some((t) => !requestTypes[t]!.includes(field))) errors.push({ code: 'WF_LINT_UNKNOWN_FIELD', rule: rule.code, field })
  }
  const n = rule.reviewers.length
  const quorumOk =
    rule.mode === 'COUNT' ? n >= 2 && rule.quorumCount !== null && Number.isInteger(rule.quorumCount) && rule.quorumCount >= 1 && rule.quorumCount <= n : n === 1 && rule.quorumCount === null
  if (!quorumOk) errors.push({ code: 'WF_LINT_QUORUM_INVALID', rule: rule.code })
}
