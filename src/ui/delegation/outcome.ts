// What a delegation server action returns to its form (NEW-06): success, or the error code with the parts of `details`
// the screen needs to say what happened and how to fix it (§9.9 rule 7, §14.2). Never the raw message.

export type DelegationOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code: string
      readonly reason?: string
      readonly field?: string
      readonly requestId?: string
    }

export type DelegationFailure = Extract<DelegationOutcome, { ok: false }>

export function toDelegationFailure(error: { code: string; details?: Readonly<Record<string, unknown>> }): DelegationFailure {
  const d = error.details ?? {}
  return {
    ok: false,
    code: error.code,
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
    ...(typeof d.field === 'string' ? { field: d.field } : {}),
    ...(typeof d.requestId === 'string' ? { requestId: d.requestId } : {}),
  }
}

/** Refusals of core/delegation (BR-DLG-01, BR-DLG-03) the screen explains in its own words */
export const DELEGATION_REASONS = ['NOTHING_TO_DELEGATE', 'OVERLAPPING_DELEGATION', 'SELF_DELEGATION', 'DELEGATE_NOT_ACTIVE', 'INVALID_PERIOD', 'INVALID_AMOUNT'] as const
export type DelegationReason = (typeof DELEGATION_REASONS)[number]

export type DelegationErrorKey =
  | DelegationReason
  | 'PAST_FIRST_DAY'
  | 'DELEGATE'
  | 'FIRST_DAY'
  | 'LAST_DAY'
  | 'AMOUNT'
  | 'REASON'
  | 'STATE'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'BUSY'
  | 'CONFLICT'
  | 'INPUT'
  | 'INTERNAL'
  | 'FAILED'

/** Message key under delegation.errors for a failed delegation action. */
export function delegationErrorKey(failure: DelegationFailure): DelegationErrorKey {
  const reason = DELEGATION_REASONS.find((r) => r === failure.reason)
  if (reason) return reason
  // The web page's own rule (src/server/services/delegations/view.ts): a delegation starts today or later
  if (failure.reason === 'PAST_FIRST_DAY') return 'PAST_FIRST_DAY'
  if (failure.code === 'VALIDATION_FAILED') {
    if (failure.field === 'delegateMemberId') return 'DELEGATE'
    if (failure.field === 'firstDay' || failure.field === 'startsAt') return 'FIRST_DAY'
    if (failure.field === 'lastDay' || failure.field === 'endsAt') return 'LAST_DAY'
    if (failure.field === 'maxAmount') return 'AMOUNT'
    if (failure.field === 'reason') return 'REASON'
    return 'INPUT'
  }
  switch (failure.code) {
    case 'INVALID_STATE_TRANSITION':
      return 'STATE'
    case 'NOT_FOUND':
    case 'FORBIDDEN':
    case 'UNAUTHENTICATED':
    case 'INTERNAL':
      return failure.code
    case 'RATE_LIMITED':
      return 'BUSY'
    case 'IDEMPOTENCY_CONFLICT':
      return 'CONFLICT'
    default:
      return 'FAILED'
  }
}
