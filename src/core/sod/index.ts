// Separation of duties (spec §7.5, BR-SOD-01 to BR-SOD-10, ADR-038 ข้อ 8). Pure: the caller states who acts and the
// people tied to the document. The route already avoids conflicting approvers (BR-DOA-06); these checks run again at
// the moment of acting, so a change of people after routing can never slip through.

import { addDays } from '../thai/day'

export interface SodPolicy {
  /** BR-SOD-02: an approver of the PR or PO may receive its goods (default false) */
  readonly approverMayReceive: boolean
  /** BR-SOD-07, OQ-04: the requester may receive their own goods (default true) */
  readonly requesterMayReceive: boolean
  /**
   * S6-09 (BR-WF-17 · OQ-109): only DOA_ADMIN drafts the DOA and the workflow; ORG_ADMIN no longer does, and nobody
   * holds both roles (default false; a version stored without the key = false)
   */
  readonly doaAdminSeparated?: boolean
}

/**
 * Every subject an approval route can be for: the single source of the list (P1-07). The first five are tier 1; the
 * rest belong to the phase-1 steps (S6 S8 S9) and route through the subject registry (ADR-068).
 */
export const APPROVAL_SUBJECTS = [
  'REQUEST',
  'PURCHASE_ORDER',
  'VARIANCE',
  'DOA_VERSION',
  'ORG_AUTHORITY_CHANGE',
  'BUDGET_TRANSFER',
  'BUDGET_OVERRUN',
  'WORKFLOW_VERSION',
  'INVOICE',
  'PO_CHANGE',
  'PAYMENT_RUN',
  'BANK_ACCOUNT_CHANGE',
] as const
export type ApprovalSubject = (typeof APPROVAL_SUBJECTS)[number]
export type OrgAuthorityChangeKind = 'POSITION_ASSIGN' | 'POSITION_END' | 'DEPARTMENT_REPARENT' | 'DELEGATION_ON_BEHALF' | 'IDENTITY_RESET'

export type SodAction =
  | {
      readonly kind: 'DECIDE_APPROVAL'
      readonly subject: ApprovalSubject
      readonly actorMemberId: string
      /** The requester, the requesters of every source PR, or the submitter of a DOA version or authority change */
      readonly requesterMemberIds: readonly string[]
      /** BR-SOD-03 */
      readonly poCreatorMemberId?: string | null
      /** BR-SOD-04 (S9): who recorded the invoices of a payment run (a retention counts its invoice's) */
      readonly invoiceRecorderMemberIds?: readonly string[]
      /** BR-SOD-10 (S9): the bank account changes in force of the run's accounts, and the window before its pay date */
      readonly recentBankChanges?: RecentBankChanges
    }
  | {
      readonly kind: 'POST_GR'
      readonly actorMemberId: string
      readonly requesterMemberIds: readonly string[]
      /** Everyone who approved the PR or the PO, delegates and their principals alike (ADR-038 ข้อ 8) */
      readonly approverMemberIds: readonly string[]
    }
  | {
      /** BR-SOD-10 (S9): preparing a run that pays into an account the preparer had changed */
      readonly kind: 'PREPARE_PAYMENT'
      readonly actorMemberId: string
      readonly recentBankChanges: RecentBankChanges
    }
  | {
      readonly kind: 'PROPOSE_ORG_AUTHORITY_CHANGE'
      readonly changeKind: OrgAuthorityChangeKind
      readonly actorMemberId: string
      /** The member who would gain: the new holder, the delegate, or the member whose identity is reset */
      readonly beneficiaryMemberId: string | null
    }

/** The changes of the accounts a run pays into (BR-SOD-10): who proposed each and the Thai day it came into force */
export interface RecentBankChanges {
  readonly payDate: string
  readonly recentBankChangeDays: number
  readonly changes: ReadonlyArray<{ readonly proposerMemberId: string; readonly effectiveOn: string }>
}

export type SodRule = 'BR-SOD-01' | 'BR-SOD-02' | 'BR-SOD-03' | 'BR-SOD-04' | 'BR-SOD-05' | 'BR-SOD-06' | 'BR-SOD-07' | 'BR-SOD-08' | 'BR-SOD-09' | 'BR-SOD-10'
export type SodResult = { readonly ok: true } | { readonly ok: false; readonly error: 'SOD_VIOLATION'; readonly rule: SodRule }

const allowed: SodResult = { ok: true }
const violation = (rule: SodRule): SodResult => ({ ok: false, error: 'SOD_VIOLATION', rule })

/** Proposals where the proposer would be the one who gains (BR-SOD-08). */
const SELF_BENEFIT_KINDS: readonly OrgAuthorityChangeKind[] = ['POSITION_ASSIGN', 'DELEGATION_ON_BEHALF', 'IDENTITY_RESET']

/** BR-SOD-10: who proposed a change that came into force on or after payDate − recentBankChangeDays */
export function recentBankChangeProposers(recent: RecentBankChanges): string[] {
  // the same window as the item's BANK_ACCOUNT_RECENTLY_CHANGED flag (../payment)
  const since = addDays(recent.payDate, -recent.recentBankChangeDays)
  return [...new Set(recent.changes.filter((c) => c.effectiveOn >= since).map((c) => c.proposerMemberId))]
}

const changedRecently = (actorMemberId: string, recent: RecentBankChanges | undefined): boolean => (recent ? recentBankChangeProposers(recent).includes(actorMemberId) : false)

/**
 * Who may not approve a payment run besides its preparer, for the `extra` of its subject adapter: the shared
 * approvals/decide.ts checks the preparer through checkSod (BR-SOD-09) and then these lists in this order, so a run is
 * refused at approval exactly as checkSod's DECIDE_APPROVAL of PAYMENT_RUN refuses it (BR-SOD-04, then BR-SOD-10)
 */
export function paymentRunSodExtra(input: { readonly invoiceRecorderMemberIds: readonly string[]; readonly recentBankChanges: RecentBankChanges }): Array<{ rule: SodRule; memberIds: string[] }> {
  return [
    { rule: 'BR-SOD-04', memberIds: [...new Set(input.invoiceRecorderMemberIds)] },
    { rule: 'BR-SOD-10', memberIds: recentBankChangeProposers(input.recentBankChanges) },
  ]
}

export function checkSod(action: SodAction, policy: SodPolicy): SodResult {
  switch (action.kind) {
    case 'DECIDE_APPROVAL': {
      const own = action.requesterMemberIds.includes(action.actorMemberId)
      // The submitter of a policy change never approves it (4-eyes)
      if (action.subject === 'DOA_VERSION') return own ? violation('BR-SOD-06') : allowed
      if (action.subject === 'ORG_AUTHORITY_CHANGE') return own ? violation('BR-SOD-08') : allowed
      // S9: the preparer, a recorder of its invoices or who changed an account it pays into never approves a run;
      // the proposer of a bank account change never approves it
      if (action.subject === 'PAYMENT_RUN') {
        if (own) return violation('BR-SOD-09')
        if ((action.invoiceRecorderMemberIds ?? []).includes(action.actorMemberId)) return violation('BR-SOD-04')
        return changedRecently(action.actorMemberId, action.recentBankChanges) ? violation('BR-SOD-10') : allowed
      }
      if (action.subject === 'BANK_ACCOUNT_CHANGE') return own ? violation('BR-SOD-05') : allowed
      if (own) return violation('BR-SOD-01')
      if (action.subject === 'PURCHASE_ORDER' && action.poCreatorMemberId === action.actorMemberId) return violation('BR-SOD-03')
      return allowed
    }
    case 'POST_GR': {
      if (!policy.approverMayReceive && action.approverMemberIds.includes(action.actorMemberId)) return violation('BR-SOD-02')
      if (!policy.requesterMayReceive && action.requesterMemberIds.includes(action.actorMemberId)) return violation('BR-SOD-07')
      return allowed
    }
    case 'PREPARE_PAYMENT':
      return changedRecently(action.actorMemberId, action.recentBankChanges) ? violation('BR-SOD-10') : allowed
    case 'PROPOSE_ORG_AUTHORITY_CHANGE':
      return SELF_BENEFIT_KINDS.includes(action.changeKind) && action.beneficiaryMemberId === action.actorMemberId ? violation('BR-SOD-08') : allowed
  }
}
