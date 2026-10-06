import { bandOf, chooseRule, resolveApprover, type DelegationSnapshot, type DoaDocumentType, type DoaRuleSnapshot, type DoaVersionSnapshot, type OrgSnapshot } from '@/core/doa'
import { higherBandLowers } from '@/core/doa/band'
import { delegateFor } from '@/core/delegation'

// "The approver of the next band" of BR-SLA-04: the amount band right above the one the route's rule covers, in the
// route's own DOA version (BR-DOA-13), walked like BR-DOA-06 walks bands for a conflicting approver — upwards only, so
// a task never goes to lower authority. A band whose approver conflicts with the document (requester, PO creator,
// submitter) or already decides the task is passed over for the band after it. So is one whose approver has a part in
// another step of the same route (NEW-47, "ไม่ให้อำนาจใครเพิ่ม"): who decided one of its steps or holds an open task on
// one, and whom the route's rule names for any of its steps — when the route was made and now, with the delegate who
// would hold the step for them. Without that, an escalation could let one person approve two steps of a route the DOA
// gives to different people (the co-assignee of step 1 who is also the approver of step 2, or who joins step 2 too).
// Passing them over is the safest reading while the user decides (ADR-048 item 2): when nobody is left above, ORG_ADMIN
// and the requester are told, as for a missing band. A rule without an amount band (GR variance, DOA_CHANGE,
// ORG_AUTHORITY_CHANGE in the demo DOA) or the top band has no next band. The approver of the band is the holder of its
// last step (tier 1 has one approver per band, OQ-01), and their own delegation applies as it does when a route is made
// (BR-DLG-04, BR-DLG-05). Pure: the caller loads the version, the organization, the delegations and the route's tasks.

export interface NextBandInput {
  readonly version: DoaVersionSnapshot
  /** The rule the route uses (ApprovalRoute.ruleCode) */
  readonly ruleCode: string
  readonly documentType: DoaDocumentType
  /** The route's amount on the version's basis (ApprovalRoute.amountSatang); null for documents without one */
  readonly basisAmountSatang: bigint | null
  /** The department whose position holders approve (BR-DOA-05) */
  readonly chargedDepartmentId: string | null
  readonly at: Date
  /** People who may not decide the document (BR-DOA-06, BR-SOD-01/03/06/08) */
  readonly conflictMemberIds: readonly string[]
  /** People who already decide the step: adding them again gives nobody new */
  readonly currentDeciderIds: readonly string[]
  /**
   * People with a part in another step of the route: who decided one (or for whom a delegate decided it), and who holds
   * an open task on one. The approvers the route's rule names for its steps are added here (NEW-47)
   */
  readonly routeMemberIds: readonly string[]
  /** When the route was made: the approvers of its later steps are the holders of then (decide.ts, next-step.ts) */
  readonly routeCreatedAt: Date
}

export type NextBand =
  | {
      readonly kind: 'FOUND'
      readonly ruleCode: string
      /** The holder the band names */
      readonly approverMemberId: string
      /** Who gets the task: the holder, or their delegate (BR-DLG-04) */
      readonly assigneeMemberId: string
      /** The holder when their delegate gets it; null otherwise */
      readonly principalMemberId: string | null
      /** e.g. "POSITION:VP@OPS": a later change of the position's holder moves the task too (BR-DOA-17) */
      readonly resolvedFrom: string
      /** The holder's delegate conflicts with the document, so the holder keeps it and ORG_ADMIN is told (BR-DLG-05) */
      readonly notifyOrgAdmin: boolean
    }
  | { readonly kind: 'NONE'; readonly reason: 'NO_HIGHER_BAND' | 'APPROVER_NOT_FOUND' | 'DOA_AMBIGUOUS'; readonly ruleCode: string | null }

/** The rule of the band right above `rule`, or why there is none */
function nextRule(version: DoaVersionSnapshot, documentType: DoaDocumentType, rule: DoaRuleSnapshot): DoaRuleSnapshot | 'NONE' | 'AMBIGUOUS' {
  if (!rule.when.amount) return 'NONE'
  const upper = bandOf(rule.when.amount).upper
  if (upper === null) return 'NONE'
  const nextLower = higherBandLowers(version, documentType, upper)[0]
  if (nextLower === undefined) return 'NONE'
  // The next band's rule is chosen as if the amount were the band's first satang (as resolveRoute does)
  const choice = chooseRule(version, documentType, nextLower + 1n, (r) => r.when.amount !== undefined && bandOf(r.when.amount).lower === nextLower)
  return choice.kind === 'rule' ? choice.rule : choice.kind === 'ambiguous' ? 'AMBIGUOUS' : 'NONE'
}

/**
 * Whom the route's rule names for its steps — the holders when the route was made and now — and the delegate who would
 * hold each step for them now (BR-DLG-04): the people of the route's steps that have not started yet, and of the others
 */
function routeHolders(rule: DoaRuleSnapshot, input: NextBandInput, org: OrgSnapshot, delegations: readonly DelegationSnapshot[], active: (memberId: string) => boolean): string[] {
  const ids: string[] = []
  for (const step of rule.steps) {
    // A position of the charged department needs one; the policy rules name organization-wide positions
    if (step.approver.kind === 'POSITION_OF_DEPARTMENT' && input.chargedDepartmentId === null) continue
    for (const at of [input.routeCreatedAt, input.at]) {
      const found = resolveApprover(step.approver, input.chargedDepartmentId ?? '', org, at)
      if (!found.found) continue
      const holder = delegateFor(
        { memberId: found.memberId, viaPosition: found.viaPosition },
        { documentType: input.documentType, basisAmountSatang: input.basisAmountSatang, at: input.at, conflictMemberIds: input.conflictMemberIds },
        delegations,
        active,
      )
      ids.push(found.memberId, holder.assigneeMemberId)
    }
  }
  return ids
}

export function nextBandApprover(input: NextBandInput, org: OrgSnapshot, delegations: readonly DelegationSnapshot[]): NextBand {
  const first = input.version.rules.find((r) => r.code === input.ruleCode && r.documentType === input.documentType)
  if (!first) return { kind: 'NONE', reason: 'NO_HIGHER_BAND', ruleCode: null }
  let rule: DoaRuleSnapshot = first
  const active = (memberId: string) => org.members.find((m) => m.id === memberId)?.active === true
  // Who may not be added: the step's own deciders, and everyone with a part in another step of the route (NEW-47)
  const taken = new Set([...input.currentDeciderIds, ...input.routeMemberIds, ...routeHolders(first, input, org, delegations, active)])
  // Each round moves to a band that starts at or above the end of the last one, so the walk always ends
  for (;;) {
    const next = nextRule(input.version, input.documentType, rule)
    if (next === 'AMBIGUOUS') return { kind: 'NONE', reason: 'DOA_AMBIGUOUS', ruleCode: rule.code }
    if (next === 'NONE') return { kind: 'NONE', reason: 'NO_HIGHER_BAND', ruleCode: null }
    rule = next
    const step = rule.steps[rule.steps.length - 1]
    if (!step || input.chargedDepartmentId === null) return { kind: 'NONE', reason: 'APPROVER_NOT_FOUND', ruleCode: rule.code }
    const found = resolveApprover(step.approver, input.chargedDepartmentId, org, input.at)
    if (!found.found) return { kind: 'NONE', reason: 'APPROVER_NOT_FOUND', ruleCode: rule.code }
    if (input.conflictMemberIds.includes(found.memberId) || taken.has(found.memberId)) continue
    const holder = delegateFor(
      { memberId: found.memberId, viaPosition: found.viaPosition },
      { documentType: input.documentType, basisAmountSatang: input.basisAmountSatang, at: input.at, conflictMemberIds: input.conflictMemberIds },
      delegations,
      active,
    )
    // A delegate who already decides the step, or has a part in another step of the route, adds nobody new: the holder
    // takes it themselves
    const delegated = holder.principalMemberId !== null && !taken.has(holder.assigneeMemberId)
    return {
      kind: 'FOUND',
      ruleCode: rule.code,
      approverMemberId: found.memberId,
      assigneeMemberId: delegated ? holder.assigneeMemberId : found.memberId,
      principalMemberId: delegated ? found.memberId : null,
      resolvedFrom: found.resolvedFrom,
      notifyOrgAdmin: holder.notifyOrgAdmin,
    }
  }
}
