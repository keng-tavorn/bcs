import { err, ok, type Result } from '@/core/result'
import { delegateFor } from '../delegation'
import { bandOf, chooseRule, higherBandLowers, type RuleChoice } from './band'
import { resolveApprover, type ApproverFound } from './approvers'
import { explainRouteTh, type ExplainedStep } from './explain'
import { DOC_TYPE_TRAITS, type DelegationSnapshot, type DoaRuleSnapshot, type DoaVersionSnapshot, type OrgSnapshot, type RouteInput, type RouteResult, type RouteStep } from './types'

// resolveRoute (spec §7.4, FR-DOA-003): which DOA version and rule apply to a document and who approves it, with the
// reason in Thai. Pure and deterministic (INV-DOA-02): same input and snapshots, same result.

export interface RoutePolicy {
  readonly versions: readonly DoaVersionSnapshot[]
  readonly org: OrgSnapshot
  readonly delegations: readonly DelegationSnapshot[]
}

/** BR-DOA-01: the PUBLISHED or SUPERSEDED version with effectiveFrom ≤ at < effectiveTo; the latest start wins. */
export function versionAt(versions: readonly DoaVersionSnapshot[], at: Date): DoaVersionSnapshot | null {
  const t = at.getTime()
  const live = versions.filter(
    (v) => (v.status === 'PUBLISHED' || v.status === 'SUPERSEDED') && v.effectiveFrom.getTime() <= t && (v.effectiveTo === null || t < v.effectiveTo.getTime()),
  )
  live.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.versionNo - a.versionNo)
  return live[0] ?? null
}

function basisAmountOf(input: RouteInput, version: DoaVersionSnapshot): bigint | null {
  if (!input.amount) return null
  return version.amountBasis === 'GROSS' ? input.amount.netSatang + input.amount.vatSatang : input.amount.netSatang
}

type Resolved =
  | { readonly kind: 'ok'; readonly approvers: readonly (ApproverFound & { readonly slaBusinessMinutes: number })[] }
  | { readonly kind: 'missing'; readonly position: string; readonly departments: readonly string[] }

function resolveRule(rule: DoaRuleSnapshot, input: RouteInput, org: OrgSnapshot): Resolved {
  const approvers: (ApproverFound & { slaBusinessMinutes: number })[] = []
  for (const step of rule.steps) {
    const found = resolveApprover(step.approver, input.chargedDepartmentId, org, input.at)
    if (!found.found) return { kind: 'missing', position: found.position, departments: found.departments }
    approvers.push({ ...found, slaBusinessMinutes: step.slaBusinessMinutes })
  }
  return { kind: 'ok', approvers }
}

function ruleChoiceError(choice: Exclude<RuleChoice, { kind: 'rule' }>, input: RouteInput): Result<never> {
  return choice.kind === 'ambiguous'
    ? err('DOA_AMBIGUOUS', 'more than one DOA rule ranks first', { documentType: input.documentType, rules: choice.rules.map((r) => r.code) })
    : err('DOA_NOT_CONFIGURED', 'no DOA rule matches the document', { documentType: input.documentType, reason: 'NO_RULE' })
}

export function resolveRoute(input: RouteInput, policy: RoutePolicy): Result<RouteResult> {
  const version = versionAt(policy.versions, input.at)
  const basisAmount = version ? basisAmountOf(input, version) : null
  const traits = DOC_TYPE_TRAITS[input.documentType]
  // BR-DOA-22: a type without an amount never takes one, so no band can be chosen by it
  if (traits.amount === 'NONE' && input.amount) {
    return err('VALIDATION_FAILED', 'this document type has no amount', { field: 'amount', reason: 'AMOUNT_NOT_ALLOWED' })
  }
  // BR-DOA-02, BR-DOA-21: a type that needs an amount needs one above zero, in total and on the version's basis
  if (traits.amount === 'REQUIRED') {
    const amount = input.amount ? input.amount.netSatang + input.amount.vatSatang : null
    if (amount === null || amount <= 0n || (basisAmount !== null && basisAmount <= 0n)) {
      return err('VALIDATION_FAILED', 'this document needs an amount above zero', { field: 'amount', reason: amount === null ? 'AMOUNT_REQUIRED' : 'AMOUNT_NOT_POSITIVE' })
    }
  }
  if (!version) return err('DOA_NOT_CONFIGURED', 'no DOA version is in effect', { documentType: input.documentType, reason: 'NO_VERSION', at: input.at.toISOString() })

  const first = chooseRule(version, input.documentType, basisAmount)
  if (first.kind !== 'rule') return ruleChoiceError(first, input)

  let rule = first.rule
  let resolved = resolveRule(rule, input, policy.org)
  // Every band skipped, in order: the explanation names each (BR-DOA-06, BR-DOA-10)
  const escalations: { rule: DoaRuleSnapshot; conflicting: ExplainedStep[] }[] = []
  // BR-DOA-06: an approver who conflicts with the document moves the route to the next band, never to lower authority
  for (;;) {
    if (resolved.kind === 'missing') {
      return err('APPROVER_NOT_FOUND', 'no current holder for the DOA step', { ruleCode: rule.code, position: resolved.position, departments: resolved.departments })
    }
    const conflicting = resolved.approvers.filter((a) => input.conflictMemberIds.includes(a.memberId))
    if (conflicting.length === 0) break
    if (version.selfApprovalPolicy === 'BLOCK') {
      return err('SOD_VIOLATION', 'the approver conflicts with the document', { rule: 'BR-DOA-06', ruleCode: rule.code })
    }
    escalations.push({ rule, conflicting: conflicting.map((a) => ({ resolvedFrom: a.resolvedFrom, assigneeMemberId: a.memberId, principalMemberId: null })) })
    // The next band starts where this one ends; a band with no upper end has nothing above it
    const currentUpper = rule.when.amount ? bandOf(rule.when.amount).upper : null
    const nextLower = currentUpper !== null ? higherBandLowers(version, input.documentType, currentUpper)[0] : undefined
    if (nextLower === undefined) {
      return err('NO_HIGHER_AUTHORITY', 'no higher band has an approver without a conflict', { ruleCode: rule.code, escalatedFromRuleCode: escalations[0]!.rule.code })
    }
    // The next band's rule is chosen as if the amount were the band's first satang
    const next = chooseRule(version, input.documentType, nextLower + 1n, (r) => r.when.amount !== undefined && bandOf(r.when.amount).lower === nextLower)
    if (next.kind !== 'rule') return ruleChoiceError(next, input)
    rule = next.rule
    resolved = resolveRule(rule, input, policy.org)
  }

  // BR-DLG-04/05: delegation of each approver's position authority; then BR-DOA-07 keeps the later of repeated approvers
  const context = { documentType: input.documentType, basisAmountSatang: basisAmount, at: input.at, conflictMemberIds: input.conflictMemberIds }
  // BR-DLG-03: a delegate who is no longer ACTIVE holds nothing
  const active = (memberId: string) => policy.org.members.find((m) => m.id === memberId)?.active === true
  let steps: Omit<RouteStep, 'stepNo'>[] = resolved.approvers.map((a) => {
    const holder = delegateFor({ memberId: a.memberId, viaPosition: a.viaPosition }, context, policy.delegations, active)
    return { ...holder, resolvedFrom: a.resolvedFrom, slaBusinessMinutes: a.slaBusinessMinutes }
  })
  if (version.collapseDuplicateApprovers) steps = steps.filter((s, i) => steps[i + 1]?.assigneeMemberId !== s.assigneeMemberId)
  const numbered: RouteStep[] = steps.map((s, i) => ({ stepNo: i + 1, ...s }))

  return ok({
    doaVersionId: version.id,
    doaCode: version.code,
    versionNo: version.versionNo,
    ruleCode: rule.code,
    escalatedFromRuleCode: escalations[0]?.rule.code ?? null,
    amountBasis: version.amountBasis,
    basisAmountSatang: basisAmount,
    steps: numbered,
    explanationTh: explainRouteTh({
      version,
      documentType: input.documentType,
      basisAmount,
      amountBasis: version.amountBasis,
      rule,
      escalations,
      steps: numbered,
      org: policy.org,
    }),
  })
}
