import type { DelegationSnapshot, DoaDocumentType, OrgSnapshot } from '../doa/types'

// Delegation (spec §7.6, BR-DLG-01 to BR-DLG-05, ADR-038 ข้อ 6–8). Pure: the caller passes the delegations, the time and
// the people who conflict with the document.

export interface DelegationContext {
  readonly documentType: DoaDocumentType
  /** Amount on the version's basis; null for documents without an amount (DOA_CHANGE, ORG_AUTHORITY_CHANGE) */
  readonly basisAmountSatang: bigint | null
  readonly at: Date
  /** People who may not decide this document (BR-SOD-01, BR-DOA-06) */
  readonly conflictMemberIds: readonly string[]
}

export interface DelegatedAssignee {
  readonly assigneeMemberId: string
  /** The delegator when the delegate holds the task; null when the approver keeps it */
  readonly principalMemberId: string | null
  /** The delegate conflicts with the document: the task stays with the delegator and ORG_ADMIN is told (BR-DLG-05) */
  readonly notifyOrgAdmin: boolean
}

/** Whether a delegation covers this task (BR-DLG-01): its document types, and its cap compared with the amount. */
export function covers(delegation: DelegationSnapshot, context: DelegationContext): boolean {
  const types = delegation.documentTypes
  if (types && types.length > 0 && !types.includes(context.documentType)) return false
  if (delegation.maxAmountSatang === null) return true
  // A capped delegation never covers a document without an amount (ADR-038 ข้อ 7); variances compare their own amount
  return context.basisAmountSatang !== null && context.basisAmountSatang <= delegation.maxAmountSatang
}

/** In effect at `at`: [startsAt, endsAt) and not revoked. */
export function inEffect(delegation: DelegationSnapshot, at: Date): boolean {
  const t = at.getTime()
  return delegation.status !== 'REVOKED' && delegation.startsAt.getTime() <= t && t < delegation.endsAt.getTime()
}

/**
 * Who holds a task whose approver came from a position (BR-DLG-04). Only the approver's own delegations count, one hop:
 * a task a delegate received is never passed on by the delegate's delegations (BR-DLG-02).
 */
export function delegateFor(
  approver: { readonly memberId: string; readonly viaPosition: boolean },
  context: DelegationContext,
  delegations: readonly DelegationSnapshot[],
): DelegatedAssignee {
  const keep: DelegatedAssignee = { assigneeMemberId: approver.memberId, principalMemberId: null, notifyOrgAdmin: false }
  if (!approver.viaPosition) return keep
  const candidates = delegations
    .filter((d) => d.delegatorMemberId === approver.memberId && d.delegateMemberId !== approver.memberId && inEffect(d, context.at) && covers(d, context))
    // Periods of one delegator never overlap (BR-DLG-03); if data ever did, the latest start wins, then the smaller id
    // (ids are unique, so no two compare equal)
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime() || (a.id < b.id ? -1 : 1))
  const delegation = candidates[0]
  if (!delegation) return keep
  if (context.conflictMemberIds.includes(delegation.delegateMemberId)) return { ...keep, notifyOrgAdmin: true }
  return { assigneeMemberId: delegation.delegateMemberId, principalMemberId: approver.memberId, notifyOrgAdmin: false }
}

export interface NewDelegation {
  readonly delegatorMemberId: string
  readonly delegateMemberId: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly documentTypes: readonly DoaDocumentType[] | null
  readonly maxAmountSatang: bigint | null
}

export type DelegationRefusal =
  | 'NOTHING_TO_DELEGATE'
  | 'OVERLAPPING_DELEGATION'
  | 'SELF_DELEGATION'
  | 'DELEGATE_NOT_ACTIVE'
  | 'INVALID_PERIOD'
  | 'INVALID_AMOUNT'

/** Holds any position at some moment of [startsAt, endsAt). */
function holdsPositionDuring(org: OrgSnapshot, memberId: string, startsAt: Date, endsAt: Date): boolean {
  const from = startsAt.getTime()
  const to = endsAt.getTime()
  return org.holders.some((h) => h.memberId === memberId && h.validFrom.getTime() < to && (h.validTo === null || h.validTo.getTime() > from))
}

/**
 * Checks a new delegation (BR-DLG-01, BR-DLG-03): the delegator must hold a position during the period, the delegate
 * must be another active member, the period must be [startsAt, endsAt) with startsAt < endsAt, a cap must be above zero,
 * and the delegator's other delegations that are not revoked or ended must not overlap. Returns null when it may be saved.
 */
export function validateNewDelegation(input: NewDelegation, existing: readonly DelegationSnapshot[], org: OrgSnapshot): DelegationRefusal | null {
  if (input.startsAt.getTime() >= input.endsAt.getTime()) return 'INVALID_PERIOD'
  if (input.maxAmountSatang !== null && input.maxAmountSatang <= 0n) return 'INVALID_AMOUNT'
  if (input.delegateMemberId === input.delegatorMemberId) return 'SELF_DELEGATION'
  if (!holdsPositionDuring(org, input.delegatorMemberId, input.startsAt, input.endsAt)) return 'NOTHING_TO_DELEGATE'
  if (!(org.members.find((m) => m.id === input.delegateMemberId)?.active ?? false)) return 'DELEGATE_NOT_ACTIVE'
  const overlaps = existing.some(
    (d) =>
      d.delegatorMemberId === input.delegatorMemberId &&
      d.status !== 'REVOKED' &&
      d.status !== 'ENDED' &&
      d.startsAt.getTime() < input.endsAt.getTime() &&
      input.startsAt.getTime() < d.endsAt.getTime(),
  )
  return overlaps ? 'OVERLAPPING_DELEGATION' : null
}

