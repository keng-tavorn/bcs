import { bandOf, type DoaRuleSnapshot } from '@/core/doa'
import type { DoaVersionData } from '@/server/doa/yaml'
import { stepKey } from './compare'

// What changed from one DOA version to the next (FR-DOA-001 AC3: the history shows each version's diff with the one
// before it). Rules are matched by code; a rule is changed when its document type, priority, amount band, approvers or
// SLA differ. Policies are the version-wide settings (BR-DOA-11, BR-SOD-02, OQ-04, OQ-07). Pure: rows in, data out.

export const POLICY_FIELDS = ['amountBasis', 'selfApprovalPolicy', 'collapseDuplicateApprovers', 'stepUpThreshold', 'approverMayReceive', 'requesterMayReceive'] as const
export type PolicyField = (typeof POLICY_FIELDS)[number]
export type PolicyValue = string | boolean | null

export const RULE_FIELDS = ['documentType', 'priority', 'band', 'approver', 'sla'] as const
export type RuleField = (typeof RULE_FIELDS)[number]

export interface VersionDiff {
  readonly policy: ReadonlyArray<{ readonly field: PolicyField; readonly before: PolicyValue; readonly after: PolicyValue }>
  /** Rule codes only in the newer version, in its order */
  readonly added: readonly string[]
  /** Rule codes only in the older version, in its order */
  readonly removed: readonly string[]
  readonly changed: ReadonlyArray<{ readonly code: string; readonly fields: readonly RuleField[] }>
}

/** The version-wide settings as plain values (money as satang text). */
export function policyValues(v: DoaVersionData): Record<PolicyField, PolicyValue> {
  return {
    amountBasis: v.amountBasis,
    selfApprovalPolicy: v.selfApprovalPolicy,
    collapseDuplicateApprovers: v.collapseDuplicateApprovers,
    stepUpThreshold: v.stepUpThresholdSatang === null ? null : v.stepUpThresholdSatang.toString(),
    approverMayReceive: v.sodPolicy.approverMayReceive,
    requesterMayReceive: v.sodPolicy.requesterMayReceive,
  }
}


/** The band as (lower exclusive, upper inclusive) in satang text, so "gte 1" and "gt 0" compare equal (BR-DOA-02). */
function bandKey(rule: DoaRuleSnapshot): string {
  if (!rule.when.amount) return '-'
  const band = bandOf(rule.when.amount)
  return `${band.lower ?? '-inf'}:${band.upper ?? 'inf'}`
}

function ruleChanges(before: DoaRuleSnapshot, after: DoaRuleSnapshot): RuleField[] {
  const fields: RuleField[] = []
  if (before.documentType !== after.documentType) fields.push('documentType')
  if (before.priority !== after.priority) fields.push('priority')
  if (bandKey(before) !== bandKey(after)) fields.push('band')
  if (before.steps.map(stepKey).join('|') !== after.steps.map(stepKey).join('|')) fields.push('approver')
  if (before.steps.map((s) => s.slaBusinessMinutes).join('|') !== after.steps.map((s) => s.slaBusinessMinutes).join('|')) fields.push('sla')
  return fields
}

export function diffVersions(before: DoaVersionData, after: DoaVersionData): VersionDiff {
  const old = policyValues(before)
  const now = policyValues(after)
  const policy = POLICY_FIELDS.filter((f) => old[f] !== now[f]).map((field) => ({ field, before: old[field], after: now[field] }))
  const beforeByCode = new Map(before.rules.map((r) => [r.code, r]))
  const afterCodes = new Set(after.rules.map((r) => r.code))
  const changed: Array<{ code: string; fields: RuleField[] }> = []
  for (const rule of after.rules) {
    const previous = beforeByCode.get(rule.code)
    if (!previous) continue
    const fields = ruleChanges(previous, rule)
    if (fields.length) changed.push({ code: rule.code, fields })
  }
  return {
    policy,
    added: after.rules.filter((r) => !beforeByCode.has(r.code)).map((r) => r.code),
    removed: before.rules.filter((r) => !afterCodes.has(r.code)).map((r) => r.code),
    changed,
  }
}
