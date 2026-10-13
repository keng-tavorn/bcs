import { anyHolderAt, departmentPath, resolveApprover, rootDepartment } from './approvers'
import { bandOf, chooseRule, isAmountOnly } from './band'
import { DOA_DOCUMENT_TYPES, DOC_TYPE_TRAITS, GOVERNANCE_DOCUMENT_TYPES, requiredDocumentTypes, type DoaDocumentType, type DoaRuleSnapshot, type DoaVersionSnapshot, type OrgSnapshot } from './types'

// lintDoaVersion and boundaryTable (spec §7.4, BR-DOA-08, BR-DOA-22, BR-DOA-23, FR-DOA-002, FR-DOA-009). Errors come in
// this order: gaps and overlaps per document type → missing required document types → governance rules nobody can
// approve on the effective date → amount bands on types without an amount → PARALLEL steps; warnings follow the order
// of the rules in the version.

export type LintCode =
  | 'DOA_LINT_GAP'
  | 'DOA_LINT_OVERLAP'
  | 'DOA_LINT_MISSING_DOCTYPE'
  | 'DOA_LINT_UNRESOLVABLE_GOVERNANCE'
  | 'DOA_LINT_PARALLEL_STEP'
  | 'DOA_LINT_AMOUNT_NOT_ALLOWED'
  | 'DOA_LINT_VACANT_POSITION'
  | 'DOA_LINT_MEMBER_APPROVER'

export interface LintIssue {
  readonly code: LintCode
  readonly documentType?: DoaDocumentType
  readonly rule?: string
  /** satang; the gap or overlap is (gt, lte], lte null = no upper end */
  readonly gt?: bigint
  readonly lte?: bigint | null
}

export interface LintResult {
  readonly errors: readonly LintIssue[]
  readonly warnings: readonly LintIssue[]
}

/**
 * BR-DOA-08 (ก): amount-only rules of one document type must cover (0, ∞) once. Bands are cut to (0, ∞) first: a band
 * empty there covers no amount, so it can neither leave a gap nor overlap; they are then taken by lower end, then upper
 * end (no end last), so the result never depends on the order of the rules.
 */
function coverageIssues(documentType: DoaDocumentType, rules: readonly DoaRuleSnapshot[]): LintIssue[] {
  const bands = rules
    .map((r) => bandOf(r.when.amount!))
    .map((b) => ({ lower: b.lower === null || b.lower < 0n ? 0n : b.lower, upper: b.upper }))
    .filter((b) => b.upper === null || b.upper > b.lower)
    .sort((a, b) => {
      if (a.lower !== b.lower) return a.lower < b.lower ? -1 : 1
      if (a.upper === b.upper) return 0
      if (a.upper === null) return 1
      if (b.upper === null) return -1
      return a.upper < b.upper ? -1 : 1
    })
  const issues: LintIssue[] = []
  // `covered` = everything up to and including this amount has a rule; amounts are above zero, so start at 0
  let covered: bigint | null = 0n
  for (const band of bands) {
    const lower = band.lower
    if (covered === null) {
      issues.push({ code: 'DOA_LINT_OVERLAP', documentType, gt: lower, lte: band.upper })
      continue
    }
    if (lower > covered) issues.push({ code: 'DOA_LINT_GAP', documentType, gt: covered, lte: lower })
    if (lower < covered) {
      const end = band.upper === null || band.upper > covered ? covered : band.upper
      issues.push({ code: 'DOA_LINT_OVERLAP', documentType, gt: lower, lte: end })
    }
    if (band.upper === null) covered = null
    else if (band.upper > covered) covered = band.upper
  }
  if (covered !== null) issues.push({ code: 'DOA_LINT_GAP', documentType, gt: covered, lte: null })
  return issues
}

/** A governance rule must find its approvers from every department (any ORG_ADMIN may submit a change). */
function governanceResolvable(rule: DoaRuleSnapshot, org: OrgSnapshot, at: Date): boolean {
  const root = rootDepartment(org)
  if (!root) return false
  const departments = org.departments.filter((d) => departmentPath(org, d.id).some((p) => p.id === root.id))
  return rule.steps.every((step) => departments.every((d) => resolveApprover(step.approver, d.id, org, at).found))
}

function vacant(rule: DoaRuleSnapshot, org: OrgSnapshot, at: Date): boolean {
  return rule.steps.some((step) => {
    if (step.approver.kind === 'MEMBER') return false
    if (step.approver.kind === 'POSITION_OF_ORG') {
      const root = rootDepartment(org)
      return !root || !resolveApprover(step.approver, root.id, org, at).found
    }
    return !anyHolderAt(org, step.approver.position, at)
  })
}

export interface LintOptions {
  /** The organisation's modules that are on; each may make more document types required (BR-DOA-23). None by default */
  readonly modules?: readonly string[]
}

export function lintDoaVersion(version: DoaVersionSnapshot, org: OrgSnapshot, at: Date, options: LintOptions = {}): LintResult {
  const errors: LintIssue[] = []
  for (const documentType of DOA_DOCUMENT_TYPES) {
    // A type without an amount has no bands to cover; a band on it is its own error below (BR-DOA-22)
    if (DOC_TYPE_TRAITS[documentType].amount === 'NONE') continue
    // The amount-only rules of a type cover (0, ∞) whatever other rules the type has (as spec_check.py lint_version)
    const rules = version.rules.filter((r) => r.documentType === documentType && isAmountOnly(r))
    if (rules.length > 0) errors.push(...coverageIssues(documentType, rules))
  }
  for (const documentType of requiredDocumentTypes(options.modules)) {
    if (!version.rules.some((r) => r.documentType === documentType)) errors.push({ code: 'DOA_LINT_MISSING_DOCTYPE', documentType })
  }
  // A governance document has no amount: it routes to the rule chooseRule picks without one. If none can be picked
  // (every rule needs an amount) or two tie, no change of DOA or authority could ever be approved
  const unroutable = new Set<string>()
  for (const documentType of GOVERNANCE_DOCUMENT_TYPES) {
    const ofType = version.rules.filter((r) => r.documentType === documentType)
    if (ofType.length > 0 && chooseRule(version, documentType, null).kind !== 'rule') for (const r of ofType) unroutable.add(r.code)
  }
  for (const rule of version.rules) {
    if (GOVERNANCE_DOCUMENT_TYPES.includes(rule.documentType) && (unroutable.has(rule.code) || !governanceResolvable(rule, org, at))) {
      errors.push({ code: 'DOA_LINT_UNRESOLVABLE_GOVERNANCE', rule: rule.code })
    }
  }
  for (const rule of version.rules) {
    if (DOC_TYPE_TRAITS[rule.documentType].amount === 'NONE' && rule.when.amount) errors.push({ code: 'DOA_LINT_AMOUNT_NOT_ALLOWED', rule: rule.code })
  }
  for (const rule of version.rules) {
    if (rule.steps.some((s) => s.mode === 'PARALLEL')) errors.push({ code: 'DOA_LINT_PARALLEL_STEP', rule: rule.code })
  }

  const warnings: LintIssue[] = []
  for (const rule of version.rules) {
    // A vacant governance approver is already an error above
    if (!GOVERNANCE_DOCUMENT_TYPES.includes(rule.documentType) && vacant(rule, org, at)) warnings.push({ code: 'DOA_LINT_VACANT_POSITION', rule: rule.code })
    if (rule.steps.some((s) => s.approver.kind === 'MEMBER')) warnings.push({ code: 'DOA_LINT_MEMBER_APPROVER', rule: rule.code })
  }
  return { errors, warnings }
}

export interface BoundaryRow {
  readonly amountSatang: bigint
  /** null when no rule or more than one rule ranks first at this amount */
  readonly ruleCode: string | null
}

/** BR-DOA-08 (ช): for every band with an upper end, the rule at the upper end and at one satang above it. A type
 * without an amount has no table (BR-DOA-22). */
export function boundaryTable(version: DoaVersionSnapshot, documentType: DoaDocumentType): BoundaryRow[] {
  if (DOC_TYPE_TRAITS[documentType].amount === 'NONE') return []
  const uppers = [
    ...new Set(
      version.rules
        .filter((r) => r.documentType === documentType && r.when.amount)
        .map((r) => bandOf(r.when.amount!).upper)
        .filter((u): u is bigint => u !== null),
    ),
    // distinct values (a Set), so no two compare equal
  ].sort((a, b) => (a < b ? -1 : 1))
  const at = (amount: bigint): BoundaryRow => {
    const choice = chooseRule(version, documentType, amount)
    return { amountSatang: amount, ruleCode: choice.kind === 'rule' ? choice.rule.code : null }
  }
  return uppers.flatMap((upper) => [at(upper), at(upper + 1n)])
}
