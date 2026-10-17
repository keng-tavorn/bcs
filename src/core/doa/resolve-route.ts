import { err, ok, type Result } from '@/core/result'
import { delegateFor } from '../delegation'
import { bandOf, chooseRule, higherBandLowers, type RuleChoice } from './band'
import { resolveApprover, type ApproverFound } from './approvers'
import { explainRouteTh, type ExplainedStep } from './explain'
import {
  DOC_TYPE_TRAITS,
  isCommitteeStep,
  type CommitteeStepSpec,
  type DelegationSnapshot,
  type DoaRuleSnapshot,
  type DoaVersionSnapshot,
  type OrgSnapshot,
  type RouteCommittee,
  type RouteInput,
  type RouteResult,
  type RouteSlot,
  type RouteStep,
} from './types'

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

/** A step of the rule with its approvers found: one, or a committee's slots after the conflicting were cut and the
 * same person's slots merged (BR-WF-02, BR-WF-03) */
type ResolvedStep =
  | { readonly kind: 'single'; readonly approver: ApproverFound; readonly slaBusinessMinutes: number }
  | {
      readonly kind: 'committee'
      readonly spec: CommitteeStepSpec
      readonly slots: readonly ApproverFound[]
      /** The quorum the route keeps: MAJORITY counted as COUNT of the approvers named (BR-WF-04) */
      readonly quorum: RouteCommittee['quorum']
      readonly quorumCount: number | null
      readonly slaBusinessMinutes: number
    }

type Resolved =
  | { readonly kind: 'ok'; readonly steps: readonly ResolvedStep[]; readonly conflicting: readonly ApproverFound[]; readonly escalate: boolean }
  | { readonly kind: 'missing'; readonly position: string; readonly departments: readonly string[] }

/** BR-WF-04: MAJORITY of the N approvers named, before any slot is cut or merged */
export const majorityOf = (n: number) => Math.floor(n / 2) + 1

/** The first slot of each person, in order (BR-WF-02: a member holds at most one slot of a step) */
function mergeSamePerson<T extends { readonly memberId: string }>(slots: readonly T[]): T[] {
  return slots.filter((s, i) => slots.findIndex((x) => x.memberId === s.memberId) === i)
}

/**
 * The approvers of every step of the rule, and whether a conflict moves the document to the next band (BR-DOA-06):
 * a single approver who conflicts does; a committee does when ALL lost a slot to a conflict, or when the slots left
 * after cutting and merging are fewer than ANY or COUNT needs (BR-WF-03). Merging alone never moves an ALL committee.
 */
function resolveRule(rule: DoaRuleSnapshot, input: RouteInput, org: OrgSnapshot): Resolved {
  const steps: ResolvedStep[] = []
  const conflicting: ApproverFound[] = []
  let escalate = false
  const conflicts = (a: ApproverFound) => input.conflictMemberIds.includes(a.memberId)
  for (const step of rule.steps) {
    if (!isCommitteeStep(step)) {
      const found = resolveApprover(step.approver, input.chargedDepartmentId, org, input.at)
      if (!found.found) return { kind: 'missing', position: found.position, departments: found.departments }
      if (conflicts(found)) {
        conflicting.push(found)
        escalate = true
      }
      steps.push({ kind: 'single', approver: found, slaBusinessMinutes: step.slaBusinessMinutes })
      continue
    }
    const found: ApproverFound[] = []
    for (const spec of step.approvers) {
      const one = resolveApprover(spec, input.chargedDepartmentId, org, input.at)
      if (!one.found) return { kind: 'missing', position: one.position, departments: one.departments }
      found.push(one)
    }
    const cut = found.filter(conflicts)
    const slots = mergeSamePerson(found.filter((a) => !conflicts(a)))
    const quorum = step.quorum === 'MAJORITY' ? 'COUNT' : step.quorum
    const quorumCount = step.quorum === 'MAJORITY' ? majorityOf(step.approvers.length) : step.quorum === 'COUNT' ? (step.quorumCount ?? step.approvers.length) : null
    const short = quorum === 'ALL' ? cut.length > 0 : slots.length < (quorumCount ?? 1)
    if (cut.length > 0) conflicting.push(...mergeSamePerson(cut))
    if (short) escalate = true
    steps.push({ kind: 'committee', spec: step, slots, quorum, quorumCount, slaBusinessMinutes: step.slaBusinessMinutes })
  }
  return { kind: 'ok', steps, conflicting, escalate }
}

/** The rule of a route already made, by its code (BR-WF-14): none of that code for the document type is NO_RULE */
function ruleOfCode(version: DoaVersionSnapshot, documentType: RouteInput['documentType'], code: string): RuleChoice {
  const rule = version.rules.find((r) => r.code === code && r.documentType === documentType)
  return rule ? { kind: 'rule', rule } : { kind: 'none' }
}

function ruleChoiceError(choice: Exclude<RuleChoice, { kind: 'rule' }>, input: RouteInput): Result<never> {
  return choice.kind === 'ambiguous'
    ? err('DOA_AMBIGUOUS', 'more than one DOA rule ranks first', { documentType: input.documentType, rules: choice.rules.map((r) => r.code) })
    : err('DOA_NOT_CONFIGURED', 'no DOA rule matches the document', { documentType: input.documentType, reason: 'NO_RULE' })
}

/**
 * options.ruleCode: the rule to start from instead of the one the amount chooses — the rule of a route already made,
 * whose waiting step finds its approvers when it starts (BR-WF-14) — still moved up a band by a conflict (BR-DOA-06)
 */
export function resolveRoute(input: RouteInput, policy: RoutePolicy, options: { readonly ruleCode?: string } = {}): Result<RouteResult> {
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

  const first: RuleChoice = options.ruleCode === undefined ? chooseRule(version, input.documentType, basisAmount) : ruleOfCode(version, input.documentType, options.ruleCode)
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
    if (!resolved.escalate) break
    if (version.selfApprovalPolicy === 'BLOCK') {
      return err('SOD_VIOLATION', 'the approver conflicts with the document', { rule: 'BR-DOA-06', ruleCode: rule.code })
    }
    escalations.push({ rule, conflicting: resolved.conflicting.map((a) => ({ resolvedFrom: a.resolvedFrom, assigneeMemberId: a.memberId, principalMemberId: null })) })
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
  const holderOf = (a: ApproverFound) => delegateFor({ memberId: a.memberId, viaPosition: a.viaPosition }, context, policy.delegations, active)
  let steps: Omit<RouteStep, 'stepNo'>[] = []
  for (const [i, step] of resolved.steps.entries()) {
    const ruleStepNo = i + 1
    if (step.kind === 'single') {
      steps.push({ ...holderOf(step.approver), ruleStepNo, resolvedFrom: step.approver.resolvedFrom, slaBusinessMinutes: step.slaBusinessMinutes })
      continue
    }
    // BR-WF-02: each slot is delegated on its own (BR-DLG-01 to 05), then a person holding two slots keeps the first
    const held = step.slots.map((a) => ({ ...holderOf(a), resolvedFrom: a.resolvedFrom }))
    const slots: RouteSlot[] = held
      .filter((h, i) => held.findIndex((x) => x.assigneeMemberId === h.assigneeMemberId) === i)
      .map((h, i) => ({ slotNo: i + 1, assigneeMemberId: h.assigneeMemberId, principalMemberId: h.principalMemberId, resolvedFrom: h.resolvedFrom, notifyOrgAdmin: h.notifyOrgAdmin }))
    // A delegate who already holds another slot leaves fewer slots than the quorum needs: the step could never pass
    if (slots.length < (step.quorumCount ?? 1)) {
      return err('APPROVER_NOT_FOUND', 'the committee has fewer members than its quorum after delegation', { ruleCode: rule.code, position: 'COMMITTEE', departments: [] })
    }
    const first = slots[0]!
    steps.push({
      ruleStepNo,
      assigneeMemberId: first.assigneeMemberId,
      principalMemberId: first.principalMemberId,
      resolvedFrom: first.resolvedFrom,
      slaBusinessMinutes: step.slaBusinessMinutes,
      notifyOrgAdmin: slots.some((x) => x.notifyOrgAdmin),
      committee: { quorum: step.quorum, quorumCount: step.quorumCount, slots },
    })
  }
  // BR-DOA-07 and BR-WF-10: repeated approvers collapse between steps of one approver only, never into a committee
  if (version.collapseDuplicateApprovers) {
    steps = steps.filter((s, i) => {
      const next = steps[i + 1]
      return !(next && s.committee === undefined && next.committee === undefined && next.assigneeMemberId === s.assigneeMemberId)
    })
  }
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
