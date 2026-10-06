import { checkSod, type SodPolicy, type SodRule } from '@/core/sod'
import { matchingGrants, type Principal } from '@/server/authz'

// Who may post a goods receipt on a PO (spec §2.4 gr.post, BR-SOD-02, BR-SOD-07, OQ-04, GC-SOD-02, GC-SOD-05): a
// RECEIVER of a department that asked for the goods, or a requester of the PO's PRs when the DOA version in effect lets
// requesters receive (sodPolicy.requesterMayReceive); then nobody who approved the PRs or the PO — a delegate and the
// member they acted for alike (ADR-038 ข้อ 8). One decision for the gr.post command, the receiving list, the receiving
// page and its preview, so a screen never offers what the command refuses.

export interface ReceivingParties {
  /** The requests the PO orders for: who asked, and for which department */
  readonly requests: ReadonlyArray<{ readonly requesterMemberId: string; readonly requesterDepartmentId: string }>
  /** Everyone who approved those requests or the PO, delegates and the members they acted for */
  readonly approvers: readonly string[]
}

export type ReceivingDecision =
  /** May post a receipt on this PO */
  | { readonly kind: 'RECEIVE' }
  /** Holds gr.post for this PO, but separation of duties refuses it (the rule says why) */
  | { readonly kind: 'SOD'; readonly rule: SodRule }
  /** No gr.post for this PO */
  | { readonly kind: 'NONE' }

/** gr.post grants of this principal for these departments and requesters, with the OQ-04 condition applied */
function receivingGrants(principal: Principal, sodPolicy: SodPolicy, parties: ReceivingParties): boolean {
  const requesters = parties.requests.map((r) => r.requesterMemberId)
  const departments = [...new Set(parties.requests.map((r) => r.requesterDepartmentId))]
  const grants = departments.flatMap((departmentId) => matchingGrants(principal, 'gr.post', { departmentId, ownerMemberIds: requesters }))
  return grants.some((g) => g.condition !== 'REQUESTER_MAY_RECEIVE' || sodPolicy.requesterMayReceive)
}

export function receivingDecision(principal: Principal, sodPolicy: SodPolicy, parties: ReceivingParties): ReceivingDecision {
  if (principal.kind !== 'member' || !receivingGrants(principal, sodPolicy, parties)) return { kind: 'NONE' }
  const sod = checkSod(
    { kind: 'POST_GR', actorMemberId: principal.memberId, requesterMemberIds: parties.requests.map((r) => r.requesterMemberId), approverMemberIds: parties.approvers },
    sodPolicy,
  )
  return sod.ok ? { kind: 'RECEIVE' } : { kind: 'SOD', rule: sod.rule }
}

/**
 * Whether the member could receive anything at all: a RECEIVER role, or any member while the DOA in effect lets
 * requesters receive their own goods. The receiving list uses it to tell "nothing to receive yet" from "not for you".
 */
export function receivesAtAll(principal: Principal, sodPolicy: SodPolicy): boolean {
  if (principal.kind !== 'member') return false
  return matchingGrants(principal, 'gr.post').some((g) => g.condition !== 'REQUESTER_MAY_RECEIVE' || sodPolicy.requesterMayReceive)
}
